const testConfig = require("../config");
const { ModelManager } = require("../../src/model-manager");
const { TenantContext } = require("../../src/tenant-context");
const { defaultLogger: logger } = require("../../src/utils/logger");
const { ulid } = require("ulid");

/**
 * Clean up test data using iteration (recommended approach)
 * All test models are now iterable, making this the primary cleanup method
 * @param {string} tenantId - Tenant ID to clean up
 * @param {Array} modelClasses - Array of model classes to clean up
 */
async function cleanupTestDataByIteration(tenantId, modelClasses) {
  if (!tenantId) {
    throw new Error("tenantId is required for cleanup");
  }

  try {
    TenantContext.setCurrentTenant(tenantId);
    
    for (const ModelClass of modelClasses) {
      // All test models should be iterable, but add safety check
      if (ModelClass.iterable) {
        logger.debug(`Cleaning up ${ModelClass.name} for tenant ${tenantId}`);
        
        for await (const batch of ModelClass.iterateAll({ batchSize: 50 })) {
          const deletePromises = batch.map(async item => {
            try {
              logger.debug(`Deleting ${ModelClass.name} item: ${item.getPrimaryId()}`);
              return await ModelClass.delete(item.getPrimaryId());
            } catch (error) {
              // Ignore TransactionCanceledException and ConditionalCheckFailed during cleanup
              if (error.name === 'TransactionCanceledException' || 
                  error.message?.includes('ConditionalCheckFailed') ||
                  error.message?.includes('Transaction cancelled')) {
                logger.debug(`Ignoring delete error for ${ModelClass.name} item ${item.getPrimaryId()}: ${error.message}`);
                return;
              }
              throw error;
            }
          });
          await Promise.all(deletePromises);
        }
        
        logger.debug(`Completed cleanup for ${ModelClass.name}`);
      } else {
        logger.warn(`Model ${ModelClass.name} is not iterable - consider adding iterable: true for easier test cleanup`);
      }
    }
    
    TenantContext.clearTenant();
    logger.debug("Cleanup complete for tenant:", tenantId);
    
    // Small delay to ensure DynamoDB consistency
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (err) {
    logger.error("Error during iteration cleanup:", err);
    TenantContext.clearTenant();
    throw err;
  }
}

/**
 * Fallback cleanup method for tracking individual items
 * Only needed for non-iterable models (rare case)
 * @param {string} tenantId - Tenant ID to clean up
 * @param {Array} trackedItems - Array of {modelClass, id} objects
 */
async function cleanupTestDataByIds(tenantId, trackedItems) {
  if (!tenantId) {
    throw new Error("tenantId is required for cleanup");
  }
  
  try {
    TenantContext.setCurrentTenant(tenantId);
    
    const deletePromises = trackedItems.map(async ({ modelClass, id }) => {
      try {
        const item = await modelClass.find(id);
        if (item.exists()) {
          logger.debug(`Deleting tracked ${modelClass.name} item: ${id}`);
          await modelClass.delete(id);
        }
      } catch (error) {
        // Continue if item doesn't exist
        logger.debug(`Item not found or already deleted: ${modelClass.name}:${id}`);
      }
    });
    
    await Promise.all(deletePromises);
    TenantContext.clearTenant();
    logger.debug("Tracked items cleanup complete for tenant:", tenantId);
  } catch (err) {
    logger.error("Error during tracked items cleanup:", err);
    TenantContext.clearTenant();
    throw err;
  }
}

/**
 * Helper function to track created items (for non-iterable models)
 * @param {Object} item - Model instance that was created
 * @param {Array} trackedItems - Array to track items in
 * @returns {Object} The original item (for chaining)
 */
function trackCreatedItem(item, trackedItems) {
  trackedItems.push({
    modelClass: item.constructor,
    id: item.getPrimaryId()
  });
  return item;
}

/**
 * Generate unique tenant ID for test isolation
 * @returns {string} Unique tenant ID
 */
function generateTestTenant() {
  return `test-${ulid()}`;
}

/**
 * Verify cleanup was successful by checking if any items remain
 * @param {string} tenantId - Tenant ID to verify
 * @param {Array} modelClasses - Array of model classes to check
 * @returns {boolean} True if cleanup was successful
 */
async function verifyCleanup(tenantId, modelClasses = []) {
  if (!tenantId) {
    logger.debug("No tenantId provided, skipping verification");
    return true;
  }

  try {
    TenantContext.setCurrentTenant(tenantId);
    
    for (const ModelClass of modelClasses) {
      if (ModelClass.iterable) {
        let itemCount = 0;
        for await (const batch of ModelClass.iterateAll({ batchSize: 10 })) {
          itemCount += batch.length;
          if (itemCount > 0) {
            logger.warn(`Warning: Found ${itemCount} items of ${ModelClass.name} after cleanup for tenant ${tenantId}`);
            // Attempt cleanup again
            for await (const batch of ModelClass.iterateAll({ batchSize: 50 })) {
              const deletePromises = batch.map(item => ModelClass.delete(item.getPrimaryId()));
              await Promise.all(deletePromises);
            }
            break;
          }
        }
      }
    }
    
    TenantContext.clearTenant();
    return true;
  } catch (err) {
    logger.error("Error during cleanup verification:", err);
    TenantContext.clearTenant();
    return false;
  }
}

/**
 * Initializes models with tenant context for testing
 * @param {Object} config - Configuration object
 * @param {string} tenantId - Tenant ID to use
 * @returns {ModelManager} The initialized model manager
 */
function initTestModelsWithTenant(config, tenantId) {
  TenantContext.setCurrentTenant(tenantId);
  const dynamoBao = require("../../src/index");
  return dynamoBao.initModels({
    ...config,
    tenancy: { enabled: true },
  });
}

/**
 * Legacy cleanup function for backward compatibility
 * Now delegates to iteration-based cleanup
 * @deprecated Use cleanupTestDataByIteration instead
 */
async function cleanupTestData(tenantIdOrTestId) {
  // Get all common test models - add models as needed
  const manager = ModelManager.getInstance(tenantIdOrTestId);
  const modelClasses = [];
  
  // Try to get common test models
  try {
    const User = manager.getModel("User");
    if (User) modelClasses.push(User);
  } catch (e) { /* Model not registered */ }
  
  try {
    const Post = manager.getModel("Post");
    if (Post) modelClasses.push(Post);
  } catch (e) { /* Model not registered */ }
  
  try {
    const Comment = manager.getModel("Comment");
    if (Comment) modelClasses.push(Comment);
  } catch (e) { /* Model not registered */ }
  
  try {
    const Tag = manager.getModel("Tag");
    if (Tag) modelClasses.push(Tag);
  } catch (e) { /* Model not registered */ }
  
  try {
    const TaggedPost = manager.getModel("TaggedPost");
    if (TaggedPost) modelClasses.push(TaggedPost);
  } catch (e) { /* Model not registered */ }
  
  try {
    const CommentLike = manager.getModel("CommentLike");
    if (CommentLike) modelClasses.push(CommentLike);
  } catch (e) { /* Model not registered */ }
  
  if (modelClasses.length > 0) {
    await cleanupTestDataByIteration(tenantIdOrTestId, modelClasses);
  } else {
    logger.warn("No test models found for cleanup");
  }
}

module.exports = {
  // New recommended functions
  cleanupTestDataByIteration,
  cleanupTestDataByIds,
  trackCreatedItem,
  generateTestTenant,
  initTestModelsWithTenant,
  
  // Legacy functions for backward compatibility
  cleanupTestData,
  verifyCleanup,
};