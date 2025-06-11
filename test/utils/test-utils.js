const testConfig = require("../config");
const { ModelManager } = require("../../src/model-manager");
const { TenantContext } = require("../../src/tenant-context");
const { QueryCommand, DeleteCommand } = require("../../src/dynamodb-client");
const { defaultLogger: logger } = require("../../src/utils/logger");

async function cleanupTestData(tenantIdOrTestId) {
  if (!tenantIdOrTestId) {
    throw new Error("tenantId/testId is required for cleanup");
  }

  try {
    const docClient = ModelManager.getInstance(tenantIdOrTestId).documentClient;

    // Query items by GSI
    const params = {
      TableName: testConfig.db.tableName,
      IndexName: "gsi_test",
      KeyConditionExpression: "#testId = :testId",
      ExpressionAttributeNames: {
        "#testId": "_gsi_test_id",
      },
      ExpressionAttributeValues: {
        ":testId": tenantIdOrTestId,
      },
    };

    const result = await docClient.send(new QueryCommand(params));

    if (result.Items && result.Items.length > 0) {
      const deletePromises = result.Items.map((item) =>
        docClient.send(
          new DeleteCommand({
            TableName: testConfig.db.tableName,
            Key: {
              _pk: item._pk,
              _sk: item._sk,
            },
          }),
        ),
      );

      await Promise.all(deletePromises);
      logger.log("Cleanup complete");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (err) {
    console.error("Error during cleanup:", err);
    throw err;
  }
}

async function verifyCleanup(tenantIdOrTestId) {
  if (!tenantIdOrTestId) {
    logger.log("No tenantId/testId provided, skipping verification");
    return true;
  }

  const manager = ModelManager.getInstance(tenantIdOrTestId);
  if (!manager) {
    console.error("Failed to get ModelManager instance for tenantId/testId:", tenantIdOrTestId);
    return false;
  }

  const docClient = manager.documentClient;
  if (!docClient) {
    console.error("Failed to get documentClient from ModelManager");
    return false;
  }

  const params = {
    TableName: testConfig.db.tableName,
    IndexName: "gsi_test",
    KeyConditionExpression: "#testId = :testId",
    ExpressionAttributeNames: {
      "#testId": "_gsi_test_id",
    },
    ExpressionAttributeValues: {
      ":testId": tenantIdOrTestId,
    },
  };

  let result = await docClient.send(new QueryCommand(params));

  if (result.Items && result.Items.length > 0) {
    console.warn("Warning: Found items after cleanup, retrying cleanup:", {
      tenantId: tenantIdOrTestId,
      itemCount: result.Items.length,
      items: result.Items,
    });

    // Wait for 100ms
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Attempt cleanup again
    await cleanupTestData(tenantIdOrTestId);

    // Re-check for items
    result = await docClient.send(new QueryCommand(params));

    if (result.Items && result.Items.length > 0) {
      throw new Error(
        `Error: Items still found after second cleanup attempt for tenantId/testId: ${tenantIdOrTestId}`,
      );
    }
  }

  return true;
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

module.exports = {
  cleanupTestData,
  verifyCleanup,
  initTestModelsWithTenant,
};
