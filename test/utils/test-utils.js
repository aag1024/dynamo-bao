const { ModelManager } = require('../../src/model-manager');
const { QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

async function cleanupTestData(testId) {
  if (!testId) {
    throw new Error('testId is required for cleanup');
  }

  try {
    const docClient = ModelManager.getInstance(testId).init({
      region: process.env.AWS_REGION,
      tableName: process.env.TABLE_NAME
    }).documentClient;
    
    // Query items by GSI
    const params = {
      TableName: process.env.TABLE_NAME,
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
          TableName: process.env.TABLE_NAME,
          Key: {
            _pk: item._pk,
            _sk: item._sk
          }
        }))
      );

      await Promise.all(deletePromises);
      console.log('Cleanup complete');
    }

  } catch (err) {
    console.error('Error during cleanup:', err);
    throw err;
  }
}

async function verifyCleanup(testId) {
  if (!testId) {
    console.log('No testId provided, skipping verification');
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
    TableName: process.env.TABLE_NAME || 'raftjs-dynamo-dev',
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
    console.warn('Warning: Found items after cleanup:', {
      testId,
      itemCount: result.Items.length,
      items: result.Items
    });
    return false;
  }

  return true;
}

module.exports = {
  cleanupTestData,
  verifyCleanup
}; 