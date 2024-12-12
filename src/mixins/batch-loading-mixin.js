const { defaultLogger: logger } = require('../utils/logger');
const { ObjectNotFound } = require('../object-not-found');
const { pluginManager } = require('../plugin-manager');

// Move these constants from model.js to here
const BATCH_REQUESTS = new Map(); // testId -> { modelName-delay -> batch }
const DEFAULT_BATCH_DELAY_MS = 5;
const BATCH_REQUEST_TIMEOUT = 10000; // 10 seconds max lifetime for a batch

const BatchLoadingMethods = {
  getBatchRequests() {
    const testId = this._testId || 'default';
    if (!BATCH_REQUESTS.has(testId)) {
      BATCH_REQUESTS.set(testId, new Map());
    }
    return BATCH_REQUESTS.get(testId);
  },

  async batchFind(primaryIds, loaderContext = null) {
    if (!primaryIds?.length) return { items: {}, ConsumedCapacity: [] };

    // Add retry wrapper function
    const retryOperation = async (operation, maxRetries = 3) => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await operation();
        } catch (error) {
          if (attempt === maxRetries - 1) throw error;
          
          // Check if it's a network-related error
          if (error.name === 'TimeoutError' || 
              error.code === 'NetworkingError' ||
              error.message.includes('getaddrinfo ENOTFOUND')) {
            const delay = Math.pow(2, attempt) * 100; // exponential backoff
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          
          throw error; // rethrow non-network errors immediately
        }
      }
    };

    // Initialize results object
    const results = {};
    let idsToLoad = [];
    
    // First check loaderContext for existing items
    if (loaderContext) {
      primaryIds.forEach(id => {
        if (loaderContext[id]) {
          const instance = new this(loaderContext[id]._data);
          results[id] = instance;
        } else {
          idsToLoad.push(id);
        }
      });
    } else {
      idsToLoad.push(...primaryIds);
    }

    // If all items were in context, return early
    if (!idsToLoad.length) {
      return { items: results, ConsumedCapacity: [] };
    }

    const consumedCapacity = [];

    // remove duplicates from idsToLoad
    idsToLoad = [...new Set(idsToLoad)];

    // Process items in batches of 100
    for (let i = 0; i < idsToLoad.length; i += 100) {
      const batchIds = idsToLoad.slice(i, i + 100);
      const Keys = batchIds.map(id => {
        const pkSk = this.parsePrimaryId(id);
        return this.getDyKeyForPkSk(pkSk);
      });

      let unprocessedKeys = Keys;
      const maxRetries = 3;
      let retryCount = 0;

      while (unprocessedKeys.length > 0 && retryCount < maxRetries) {
        // Wrap the batchGet call with our retry function
        const batchResult = await retryOperation(() => 
          this.documentClient.batchGet({
            RequestItems: {
              [this.table]: {
                Keys: unprocessedKeys
              }
            },
            ReturnConsumedCapacity: 'TOTAL'
          })
        );

        // Process successful items
        if (batchResult.Responses?.[this.table]) {
          batchResult.Responses[this.table].forEach(item => {
            const instance = new this(item);
            const primaryId = instance.getPrimaryId();
            results[primaryId] = instance;
            
            // Add to loader context if provided
            if (loaderContext) {
              loaderContext[primaryId] = instance;
            }
          });
        }

        // Track consumed capacity
        if (batchResult.ConsumedCapacity) {
          consumedCapacity.push(...[].concat(batchResult.ConsumedCapacity));
        }

        // Handle unprocessed keys
        unprocessedKeys = batchResult.UnprocessedKeys?.[this.table]?.Keys || [];
        
        if (unprocessedKeys.length > 0) {
          retryCount++;
          // Add exponential backoff if needed
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 100));
        }
      }

      // If we still have unprocessed keys after retries, log a warning
      if (unprocessedKeys.length > 0) {
        console.warn(`Failed to process ${unprocessedKeys.length} items after ${maxRetries} retries`);
      }
    }

    return {
      items: results,
      ConsumedCapacity: consumedCapacity
    };
  },

  async find(primaryId, options = {}) {
    const batchDelay = options.batchDelay ?? DEFAULT_BATCH_DELAY_MS;
    const loaderContext = options.loaderContext;
    
    // Check loader context first
    if (loaderContext && loaderContext[primaryId]) {
      const cachedItem = loaderContext[primaryId];
      const instance = new this(cachedItem._data);
      const consumedCapacity = cachedItem.getConsumedCapacity().consumedCapacity;
      instance.addConsumedCapacity(consumedCapacity, 'read', true);
      return instance;
    }

    if (batchDelay === 0) {
      // Direct DynamoDB request logic
      const pkSk = this.parsePrimaryId(primaryId);
      const dyKey = this.getDyKeyForPkSk(pkSk);
      const result = await this.documentClient.get({
        TableName: this.table,
        Key: dyKey,
        ReturnConsumedCapacity: 'TOTAL'
      });

      let instance;
      if (!result.Item) {
        instance = new ObjectNotFound(result.ConsumedCapacity);
      } else {
        instance = new this(result.Item);
        instance.addConsumedCapacity(result.ConsumedCapacity, 'read', false);
      }
      
      // Add to loader context if provided
      if (loaderContext) {
        loaderContext[primaryId] = instance;
      }
      
      return instance;
    }

    // Batch request logic
    return new Promise((resolve, reject) => {
      const batchKey = `${this.name}-${batchDelay}`;
      const batchRequests = this.getBatchRequests();
      let batchRequest = batchRequests.get(batchKey);

      if (!batchRequest) {
        batchRequest = {
          model: this,
          items: [],
          timer: null,
          timeoutTimer: null,
          delay: batchDelay,
          createdAt: Date.now(),
          loaderContext
        };
        batchRequests.set(batchKey, batchRequest);

        // Set batch execution timer
        batchRequest.timer = setTimeout(async () => {
          try {
            const currentBatch = batchRequests.get(batchKey);
            if (!currentBatch) return;

            const batchIds = currentBatch.items.map(item => item.id);
            
            // Execute bulk find
            const { items, ConsumedCapacity } = await this.batchFind(batchIds, loaderContext);

            // total callbacks
            const totalCallbacks = currentBatch.items.reduce((sum, item) => sum + item.callbacks.length, 0);
            
            // Resolve all promises, including multiple callbacks for the same ID
            const consumedCapacity = {
              TableName: this.table,
              CapacityUnits: ConsumedCapacity[0]?.CapacityUnits / totalCallbacks
            }
            
            currentBatch.items.forEach(batchItem => {
              let item = items[batchItem.id];
              if (item) {
                item.addConsumedCapacity(consumedCapacity, 'read', false);
              } else {
                item = new ObjectNotFound(consumedCapacity);
              }
              batchItem.callbacks.forEach(cb => cb.resolve(item));
            });

            // Clean up the batch and BOTH timers
            if (currentBatch.timeoutTimer) {
              clearTimeout(currentBatch.timeoutTimer);
            }
            if (currentBatch.timer) {
              clearTimeout(currentBatch.timer);
            }
            batchRequests.delete(batchKey);
          } catch (error) {
            const currentBatch = batchRequests.get(batchKey);
            if (currentBatch) {
              currentBatch.items.forEach(batchItem => {
                batchItem.callbacks.forEach(cb => cb.reject(error));
              });
              if (currentBatch.timeoutTimer) {
                clearTimeout(currentBatch.timeoutTimer);
              }
              if (currentBatch.timer) {
                clearTimeout(currentBatch.timer);
              }
              batchRequests.delete(batchKey);
            }
          }
        }, batchDelay);

        // Set timeout timer
        batchRequest.timeoutTimer = setTimeout(() => {
          const currentBatch = batchRequests.get(batchKey);
          if (currentBatch === batchRequest) {
            if (currentBatch.timer) {
              clearTimeout(currentBatch.timer);
            }
            batchRequests.delete(batchKey);
            currentBatch.items.forEach(batchItem => {
              batchItem.callbacks.forEach(cb => cb.reject(new Error('Batch request timed out')));
            });
          }
        }, BATCH_REQUEST_TIMEOUT);
      }

      // Add this request to the batch
      const existingItem = batchRequest.items.find(item => item.id === primaryId);
      if (existingItem) {
        existingItem.callbacks.push({ resolve, reject });
      } else {
        batchRequest.items.push({
          id: primaryId,
          callbacks: [{ resolve, reject }]
        });
      }
    });
  }
};

module.exports = {
  BatchLoadingMethods,
  BATCH_REQUESTS,
  DEFAULT_BATCH_DELAY_MS,
  BATCH_REQUEST_TIMEOUT
}; 