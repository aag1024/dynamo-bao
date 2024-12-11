const testConfig = require('../config');
const { ModelManager } = require('../../src/model-manager');
const { QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { defaultLogger: logger } = require('../../src/utils/logger');


async function cleanupTestData(testId) {
  if (!testId) {
    throw new Error('testId is required for cleanup');
  }

  try {
    const docClient = ModelManager.getInstance(testId).documentClient;

    // Query items by GSI
    const params = {
      TableName: testConfig.db.tableName,
      IndexName: 'gsi_test',
      KeyConditionExpression: '#testId = :testId',
      ExpressionAttributeNames: {
        '#testId': '_gsi_test_id'
      },
      ExpressionAttributeValues: {
        ':testId': testId
      }
    };

    const result = await docClient.send(new QueryCommand(params));
    
    if (result.Items && result.Items.length > 0) {
      const deletePromises = result.Items.map(item => 
        docClient.send(new DeleteCommand({
          TableName: testConfig.db.tableName,
          Key: {
            _pk: item._pk,
            _sk: item._sk
          }
        }))
      );

      await Promise.all(deletePromises);
      logger.log('Cleanup complete');
      await new Promise(resolve => setTimeout(resolve, 100));
    }

  } catch (err) {
    console.error('Error during cleanup:', err);
    throw err;
  }
}

async function verifyCleanup(testId) {
  if (!testId) {
    logger.log('No testId provided, skipping verification');
    return true;
  }

  const manager = ModelManager.getInstance(testId);
  if (!manager) {
    console.error('Failed to get ModelManager instance for testId:', testId);
    return false;
  }

  const docClient = manager.documentClient;
  if (!docClient) {
    console.error('Failed to get documentClient from ModelManager');
    return false;
  }

  const params = {
    TableName: testConfig.db.tableName,
    IndexName: 'gsi_test',
    KeyConditionExpression: '#testId = :testId',
    ExpressionAttributeNames: {
      '#testId': '_gsi_test_id'
    },
    ExpressionAttributeValues: {
      ':testId': testId
    }
  };

  let result = await docClient.send(new QueryCommand(params));

  if (result.Items && result.Items.length > 0) {
    console.warn('Warning: Found items after cleanup, retrying cleanup:', {
      testId,
      itemCount: result.Items.length,
      items: result.Items
    });

    // Wait for 100ms
    await new Promise(resolve => setTimeout(resolve, 100));

    // Attempt cleanup again
    await cleanupTestData(testId);

    // Re-check for items
    result = await docClient.send(new QueryCommand(params));

    if (result.Items && result.Items.length > 0) {
      throw new Error(`Error: Items still found after second cleanup attempt for testId: ${testId}`);
    }
  }

  return true;
}

module.exports = {
  cleanupTestData,
  verifyCleanup
}; 