const { defaultLogger: logger } = require("../utils/logger");
const { ObjectNotFound } = require("../object-not-found");
const { pluginManager } = require("../plugin-manager");
const { BatchGetCommand, GetCommand } = require("../dynamodb-client");
const defaultConfig = require("../config");

// Import AsyncLocalStorage for request-scoped batching
let AsyncLocalStorage;
try {
  AsyncLocalStorage = require("node:async_hooks").AsyncLocalStorage;
} catch (e) {
  // Fallback for environments without AsyncLocalStorage
  AsyncLocalStorage = null;
}

// Request-scoped batch context
const batchContext = AsyncLocalStorage ? new AsyncLocalStorage() : null;

const DEFAULT_BATCH_DELAY_MS = 5;
const BATCH_REQUEST_TIMEOUT = 10000; // 10 seconds max lifetime for a batch

/**
 * Accumulate capacity units to the current batch context.
 * This is called internally by model operations to track total capacity consumed.
 * @param {number} capacityUnits - The capacity units to accumulate
 * @param {string} type - Either "read" or "write"
 */
function _accumulateCapacityToContext(capacityUnits, type) {
  if (!batchContext) return;
  const context = batchContext.getStore();
  if (context?.capacityAccumulator && typeof capacityUnits === "number") {
    context.capacityAccumulator[type] += capacityUnits;
  }
}

/**
 * Return a ConsumedCapacity object with `extraUnits` added to its CapacityUnits.
 * Used so the legacy-fallback reads (migrating mode) are reflected in the
 * capacity carried by the returned item/ObjectNotFound, not just the context.
 */
function _withExtraCapacityUnits(consumedCapacity, extraUnits) {
  if (!extraUnits) return consumedCapacity;
  return {
    ...consumedCapacity,
    CapacityUnits: (consumedCapacity?.CapacityUnits || 0) + extraUnits,
  };
}

/**
 * Get the total consumed capacity for the current batch context.
 * Returns the accumulated RCUs and WCUs for all operations within the current
 * runWithBatchContext scope.
 *
 * @returns {{ read: number, write: number }} The accumulated capacity, or { read: 0, write: 0 } if not in a batch context
 *
 * @example
 * import { runWithBatchContext, getBatchContextCapacity } from "dynamo-bao";
 *
 * await runWithBatchContext(async () => {
 *   await User.find(userId);
 *   await Post.queryByIndex('byUser', userId);
 *
 *   const capacity = getBatchContextCapacity();
 *   console.log(`Read: ${capacity.read} RCUs, Write: ${capacity.write} WCUs`);
 * });
 */
function getBatchContextCapacity() {
  if (!batchContext) {
    return { read: 0, write: 0 };
  }
  const context = batchContext.getStore();
  if (!context?.capacityAccumulator) {
    return { read: 0, write: 0 };
  }
  return { ...context.capacityAccumulator };
}

const BatchLoadingMethods = {
  _getBatchRequests() {
    // AsyncLocalStorage is required - check for context
    if (batchContext) {
      const context = batchContext.getStore();
      if (context && context.batchRequests) {
        return context.batchRequests;
      }
    }

    // Check if we should require batch context
    const modelConfig = this._config || {};
    const batchContextConfig = modelConfig.batchContext || {
      requireBatchContext: false,
    };
    if (batchContextConfig.requireBatchContext) {
      // No batch context found - operations must be within runWithBatchContext
      throw new Error(
        "Batch operations must be executed within runWithBatchContext(). " +
          "Wrap your database operations in runWithBatchContext() to enable batching and caching.",
      );
    }

    // Fallback: Return null to indicate no batch context available
    return null;
  },

  /**
   * Check if currently executing within a batch context
   * @returns {boolean} True if inside a batch context, false otherwise
   */
  isInsideBatchContext() {
    if (!batchContext) {
      return false;
    }

    const context = batchContext.getStore();
    return !!(context && context.batchRequests);
  },

  /**
   * Key for the request-scoped loader cache. The cache is one Map per request
   * shared by every model and tenant, so the key carries both, plus the
   * canonical string id so a string id and its object form share an entry.
   * @private
   */
  _loaderKey(primaryId) {
    const pkSk = this._parsePrimaryId(primaryId);
    return JSON.stringify([
      this.name,
      this.manager.getTenantId() ?? null,
      this.makePrimaryId(pkSk.pk, pkSk.sk),
    ]);
  },

  /**
   * Store a just-written instance in the request-scoped loader cache so a
   * later find() in the same request returns the written row instead of a
   * stale one. Caches a copy with no consumed capacity, so later operations
   * that load it don't report this write's capacity as their own. No-op
   * outside runWithBatchContext().
   * @private
   */
  _primeLoaderContext(primaryId, instance) {
    const loaderContext = batchContext?.getStore()?.loaderContext;
    if (loaderContext) {
      loaderContext.set(
        this._loaderKey(primaryId),
        this._createFromDyItem({ ...instance._dyData }),
      );
    }
  },

  /**
   * Drop a just-deleted item from the request-scoped loader cache so a later
   * find() in the same request doesn't return the deleted row. No-op outside
   * runWithBatchContext().
   * @private
   */
  _evictFromLoaderContext(primaryId) {
    const loaderContext = batchContext?.getStore()?.loaderContext;
    if (loaderContext) {
      loaderContext.delete(this._loaderKey(primaryId));
    }
  },

  /**
   * @memberof BaoModel
   * @description
   * This is the primary way to load multiple objects given an array of ids.
   * This function should only be used when {@link BaoModel.find} or {@link BaoModel#loadRelatedData} is not sufficient.
   *
   * @param {string[]} primaryIds - The primary IDs of the items to load
   * @returns {Promise<Object>} Returns a promise that resolves to the loaded items and their consumed capacity
   */
  async batchFind(primaryIds) {
    if (!primaryIds?.length) return { items: {}, ConsumedCapacity: [] };

    // Get batch context and loader context - will be null if not in batch context
    const batchRequests = this._getBatchRequests();
    const context = batchContext?.getStore();
    const loaderContext = context?.loaderContext;

    // Add retry wrapper function
    const retryOperation = async (operation, maxRetries = 3) => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await operation();
        } catch (error) {
          if (attempt === maxRetries - 1) throw error;

          // Check if it's a network-related error
          if (
            error.name === "TimeoutError" ||
            error.code === "NetworkingError" ||
            error.message.includes("getaddrinfo ENOTFOUND")
          ) {
            const delay = Math.pow(2, attempt) * 100; // exponential backoff
            await new Promise((resolve) => setTimeout(resolve, delay));
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
      primaryIds.forEach((id) => {
        const loaderKey = this._loaderKey(id);
        if (loaderContext.has(loaderKey)) {
          const instance = this._createFromDyItem(
            loaderContext.get(loaderKey)._dyData,
          );
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
      const Keys = batchIds.map((id) => {
        const pkSk = this._parsePrimaryId(id);
        return this._getDyKeyForPkSk(pkSk);
      });

      let unprocessedKeys = Keys;
      const maxRetries = 3;
      let retryCount = 0;

      while (unprocessedKeys.length > 0 && retryCount < maxRetries) {
        // Wrap the batchGet call with our retry function
        const batchResult = await retryOperation(() =>
          this.documentClient.send(
            new BatchGetCommand({
              RequestItems: {
                [this.table]: {
                  Keys: unprocessedKeys,
                },
              },
              ReturnConsumedCapacity: "TOTAL",
            }),
          ),
        );

        // Process successful items
        if (batchResult.Responses?.[this.table]) {
          batchResult.Responses[this.table].forEach((item) => {
            const instance = this._createFromDyItem(item);
            const primaryId = instance.getPrimaryId();
            results[primaryId] = instance;

            // Add to loader context if provided
            if (loaderContext) {
              loaderContext.set(this._loaderKey(primaryId), instance);
            }
          });
        }

        // Track consumed capacity
        if (batchResult.ConsumedCapacity) {
          consumedCapacity.push(...[].concat(batchResult.ConsumedCapacity));
          // Accumulate to batch context
          const capacityArray = [].concat(batchResult.ConsumedCapacity);
          for (const cap of capacityArray) {
            _accumulateCapacityToContext(cap?.CapacityUnits || 0, "read");
          }
        }

        // Handle unprocessed keys
        unprocessedKeys = batchResult.UnprocessedKeys?.[this.table]?.Keys || [];

        if (unprocessedKeys.length > 0) {
          retryCount++;
          // Add exponential backoff if needed
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, retryCount) * 100),
          );
        }
      }

      // If we still have unprocessed keys after retries, log a warning
      if (unprocessedKeys.length > 0) {
        console.warn(
          `Failed to process ${unprocessedKeys.length} items after ${maxRetries} retries`,
        );
      }
    }

    // Migration read fallback (pk === "modelPrefix", "migrating" mode only):
    // ids not found at the canonical tenant-scoped key may still live at a
    // legacy key shape. Resolve those individually — the miss set is small and
    // only present mid-migration.
    if (
      this.primaryKey.pk === "modelPrefix" &&
      this._modelPrefixPkMode() === "migrating"
    ) {
      for (const id of idsToLoad) {
        if (results[id]) continue;
        const fb = await this._getRawItemWithLegacyFallback(
          this._parsePrimaryId(id),
        );
        if (fb.consumedUnits) {
          consumedCapacity.push({ CapacityUnits: fb.consumedUnits });
          _accumulateCapacityToContext(fb.consumedUnits, "read");
        }
        if (fb.item) {
          const instance = this._createFromDyItem(fb.item);
          results[instance.getPrimaryId()] = instance;
          if (loaderContext) loaderContext.set(this._loaderKey(id), instance);
        }
      }
    }

    return {
      items: results,
      ConsumedCapacity: consumedCapacity,
    };
  },

  /**
   *@memberof BaoModel
   *
   * @description
   * Find is the primary way to look up an object given its id. It will return the object
   * if it exists, or an {@link ObjectNotFound} instance if it does not. Find supports
   * efficient batch loading and caching. In general, this function should be
   * preferred over {@link BaoModel.batchFind}. Find uses batchFind internally, unless batchDelay
   * is set to 0.
   *
   * @param {string} primaryId - The primary ID of the item to find
   * @param {Object} [options={}] - Optional configuration for the find operation
   * @param {number} [options.batchDelay=5] - Delay in milliseconds before executing batch request.
   *                                         Set to 0 for immediate individual requests
   * @param {boolean} [options.bypassCache=false] - If true, bypasses both batching and caching entirely
   * @returns {Promise<Object>} Returns a promise that resolves to the found item instance or ObjectNotFound
   * @throws {Error} If the batch request times out or other errors occur during the operation
   */
  async find(primaryId, options = {}) {
    const batchDelay = options.batchDelay ?? DEFAULT_BATCH_DELAY_MS;
    const bypassCache = options.bypassCache ?? false;

    // Ensure we're within a batch context (unless bypassing everything for AsyncLocalStorage availability check)
    if (!batchContext) {
      throw new Error(
        "AsyncLocalStorage is not available. Dynamo-bao requires Node.js with AsyncLocalStorage support.",
      );
    }

    const context = batchContext.getStore();
    if (!context) {
      // Check if we should require batch context
      const modelConfig = this._config || {};
      const batchContextConfig = modelConfig.batchContext || {
        requireBatchContext: false,
      };
      if (batchContextConfig.requireBatchContext) {
        throw new Error(
          "Batch operations must be executed within runWithBatchContext(). " +
            "Wrap your database operations in runWithBatchContext() to enable batching and caching.",
        );
      }

      // Fallback behavior: direct execution without batching or caching
      return this._executeFindDirect(primaryId);
    }

    // Get automatic loaderContext from batch context
    let loaderContext = null;
    if (!bypassCache && context?.loaderContext) {
      loaderContext = context.loaderContext;
    }

    // Check loader context first (unless bypassing cache)
    const loaderKey = loaderContext ? this._loaderKey(primaryId) : null;
    if (!bypassCache && loaderContext && loaderContext.has(loaderKey)) {
      const cachedItem = loaderContext.get(loaderKey);
      // Return the exact same cached object instance for true caching
      return cachedItem;
    }

    // bypassCache skips batching too: a batch resolves through batchFind,
    // which reads the loader cache.
    if (batchDelay === 0 || bypassCache) {
      // Direct DynamoDB request logic
      const pkSk = this._parsePrimaryId(primaryId);
      const dyKey = this._getDyKeyForPkSk(pkSk);
      const result = await this.documentClient.send(
        new GetCommand({
          TableName: this.table,
          Key: dyKey,
          ReturnConsumedCapacity: "TOTAL",
        }),
      );

      let item = result.Item;
      let fallbackUnits = 0;
      if (!item) {
        const fb = await this._getRawItemWithLegacyFallback(pkSk);
        item = fb.item;
        fallbackUnits = fb.consumedUnits;
      }

      let instance;
      if (!item) {
        instance = new ObjectNotFound(
          _withExtraCapacityUnits(result.ConsumedCapacity, fallbackUnits),
        );
        // Accumulate capacity for ObjectNotFound since _addConsumedCapacity isn't called
        _accumulateCapacityToContext(
          (result.ConsumedCapacity?.CapacityUnits || 0) + fallbackUnits,
          "read",
        );
      } else {
        instance = this._createFromDyItem(item);
        instance._addConsumedCapacity(result.ConsumedCapacity, "read", false);
        if (fallbackUnits) {
          instance._addConsumedCapacity(
            { CapacityUnits: fallbackUnits },
            "read",
            false,
          );
        }
      }

      // Add to loader context if provided (unless bypassing cache)
      if (!bypassCache && loaderContext) {
        loaderContext.set(loaderKey, instance);
      }

      return instance;
    }

    // Batch request logic
    return new Promise((resolve, reject) => {
      // One batch per model, tenant and delay: the batch builds its keys in
      // the first caller's async context, so it must not mix tenants.
      const tenantId = this.manager.getTenantId() ?? "";
      const batchKey = `${this.name}-${tenantId}-${batchDelay}`;
      const batchRequests = this._getBatchRequests();
      let batchRequest = batchRequests.get(batchKey);

      if (!batchRequest) {
        batchRequest = {
          model: this,
          items: [],
          timer: null,
          timeoutTimer: null,
          delay: batchDelay,
          createdAt: Date.now(),
          loaderContext: bypassCache ? null : loaderContext,
        };
        batchRequests.set(batchKey, batchRequest);

        // Set batch execution timer
        batchRequest.timer = setTimeout(async () => {
          try {
            const currentBatch = batchRequests.get(batchKey);
            if (!currentBatch) return;

            const batchIds = currentBatch.items.map((item) => item.id);

            // Execute bulk find
            const { items, ConsumedCapacity } = await this.batchFind(
              batchIds,
              loaderContext,
            );

            // total callbacks
            const totalCallbacks = currentBatch.items.reduce(
              (sum, item) => sum + item.callbacks.length,
              0,
            );

            // Resolve all promises, including multiple callbacks for the same ID.
            // Sum ALL ConsumedCapacity entries (multiple BatchGet pages and any
            // legacy-fallback GetItems in migrating mode), not just the first,
            // so the per-operation capacity isn't under-reported.
            const totalUnits = (ConsumedCapacity || []).reduce(
              (sum, c) => sum + (c?.CapacityUnits || 0),
              0,
            );
            const consumedCapacity = {
              TableName: this.table,
              CapacityUnits: totalCallbacks ? totalUnits / totalCallbacks : 0,
            };

            currentBatch.items.forEach((batchItem) => {
              let item = items[batchItem.id];
              if (item) {
                // Skip context accumulation since batchFind already accumulated the total
                item._addConsumedCapacity(
                  consumedCapacity,
                  "read",
                  false,
                  true,
                );
              } else {
                item = new ObjectNotFound(consumedCapacity);
              }
              batchItem.callbacks.forEach((cb) => cb.resolve(item));
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
              currentBatch.items.forEach((batchItem) => {
                batchItem.callbacks.forEach((cb) => cb.reject(error));
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
            currentBatch.items.forEach((batchItem) => {
              batchItem.callbacks.forEach((cb) =>
                cb.reject(new Error("Batch request timed out")),
              );
            });
          }
        }, BATCH_REQUEST_TIMEOUT);
      }

      // Add this request to the batch
      const existingItem = batchRequest.items.find(
        (item) => item.id === primaryId,
      );
      if (existingItem) {
        existingItem.callbacks.push({ resolve, reject });
      } else {
        batchRequest.items.push({
          id: primaryId,
          callbacks: [{ resolve, reject }],
        });
      }
    });
  },

  /**
   * Read fallback for the `pk === "modelPrefix"` migration. When a record is
   * not found at the canonical (tenant-scoped) key while in "migrating" mode,
   * try the legacy key shapes so pre-migration rows remain resolvable.
   *
   * Returns the raw DynamoDB item (with its actual stored `_pk`/`_sk`) or null,
   * plus the total capacity consumed across the fallback GetItem(s). The CALLER
   * is responsible for accounting that capacity (so it is reflected in the
   * returned per-operation ConsumedCapacity, not just the batch context).
   * @param {Object} pkSk - Parsed primary key values
   * @returns {Promise<{ item: Object|null, consumedUnits: number }>}
   */
  async _getRawItemWithLegacyFallback(pkSk) {
    const legacyKeys = this._legacyDyKeysForPkSk(pkSk);
    let consumedUnits = 0;
    for (const Key of legacyKeys) {
      const result = await this.documentClient.send(
        new GetCommand({
          TableName: this.table,
          Key,
          ReturnConsumedCapacity: "TOTAL",
        }),
      );
      consumedUnits += result.ConsumedCapacity?.CapacityUnits || 0;
      if (result.Item) return { item: result.Item, consumedUnits };
    }
    return { item: null, consumedUnits };
  },

  /**
   * Execute find operation directly without batching or caching
   * @param {string} primaryId - The primary ID to find
   * @returns {Promise<Object>} The found item or ObjectNotFound
   */
  async _executeFindDirect(primaryId) {
    const pkSk = this._parsePrimaryId(primaryId);
    const dyKey = this._getDyKeyForPkSk(pkSk);
    const result = await this.documentClient.send(
      new GetCommand({
        TableName: this.table,
        Key: dyKey,
        ReturnConsumedCapacity: "TOTAL",
      }),
    );

    let item = result.Item;
    let fallbackUnits = 0;
    if (!item) {
      const fb = await this._getRawItemWithLegacyFallback(pkSk);
      item = fb.item;
      fallbackUnits = fb.consumedUnits;
    }

    if (!item) {
      return new ObjectNotFound(
        _withExtraCapacityUnits(result.ConsumedCapacity, fallbackUnits),
      );
    } else {
      const instance = this._createFromDyItem(item);
      instance._addConsumedCapacity(result.ConsumedCapacity, "read", false);
      if (fallbackUnits) {
        instance._addConsumedCapacity(
          { CapacityUnits: fallbackUnits },
          "read",
          false,
        );
      }
      return instance;
    }
  },
};

/**
 * Initialize batch context for request-scoped batching.
 * This should be called at the beginning of each request in Cloudflare Workers.
 * @param {Function} fn - Function to run within the batch context
 * @returns {*} Result of the function
 */
function runWithBatchContext(fn) {
  if (!batchContext) {
    // No AsyncLocalStorage available, just run the function
    return fn();
  }

  const context = {
    requestId: Date.now().toString(36) + Math.random().toString(36).substr(2),
    batchRequests: new Map(),
    loaderContext: new Map(), // Add automatic loaderContext
    timers: new Set(),
    startTime: Date.now(),
    capacityAccumulator: { read: 0, write: 0 }, // Track total capacity consumed
  };

  return batchContext.run(context, fn);
}

module.exports = {
  BatchLoadingMethods,
  runWithBatchContext,
  getBatchContextCapacity,
  _accumulateCapacityToContext,
  DEFAULT_BATCH_DELAY_MS,
  BATCH_REQUEST_TIMEOUT,
};
