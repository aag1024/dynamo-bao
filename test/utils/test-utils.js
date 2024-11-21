const { ModelManager } = require('../../src/model-manager');

async function verifyCleanup(docClient, tableName) {
  if (!docClient) {
    throw new Error('docClient is required for cleanup verification');
  }
  if (!tableName) {
    throw new Error('tableName is required for cleanup verification');
  }
  
  const scanResult = await docClient.scan({
    TableName: tableName,
    FilterExpression: 'begins_with(#pk, :prefix1) OR begins_with(#pk, :prefix2) OR begins_with(#pk, :prefix3) OR begins_with(#pk, :prefix4)',
    ExpressionAttributeNames: {
      '#pk': '_pk'
    },
    ExpressionAttributeValues: {
      ':prefix1': 'u#',
      ':prefix2': '_raft_uc#',
      ':prefix3': 'p#',
      ':prefix4': '_raft_uc#'
    }
  });

  if (scanResult.Items.length > 0) {
    console.log('Warning: Found items after cleanup:', scanResult.Items);
    throw new Error('Cleanup verification failed');
  }
}

async function cleanupTestData(docClient, tableName) {
  if (!docClient) {
    throw new Error('docClient is required for cleanup');
  }
  if (!tableName) {
    throw new Error('tableName is required for cleanup');
  }
  
  console.log('\nCleaning up test data...');

  const scanParams = {
    TableName: tableName,
    FilterExpression: 'begins_with(#pk, :prefix1) OR begins_with(#pk, :prefix2) OR begins_with(#pk, :prefix3) OR begins_with(#pk, :prefix4) OR begins_with(#pk, :prefix5) OR begins_with(#pk, :prefix6)',
    ExpressionAttributeNames: {
      '#pk': '_pk'
    },
    ExpressionAttributeValues: {
      ':prefix1': 'u#',  // User
      ':prefix2': 'p#',  // Post
      ':prefix3': 't#',  // Tag
      ':prefix4': 'tp#', // TaggedPost
      ':prefix5': '_raft_uc#', // Unique constraints
      ':prefix6': '_raft_uc#'  // Additional unique constraints
    }
  };

  try {
    const { Items = [] } = await docClient.scan(scanParams);
    
    if (Items.length === 0) {
      console.log('No test data to clean up');
      return;
    }

    console.log(`Found ${Items.length} items to delete`);

    // Batch delete items in chunks of 25 (DynamoDB limit)
    const chunks = [];
    for (let i = 0; i < Items.length; i += 25) {
      chunks.push(Items.slice(i, i + 25));
    }

    for (const chunk of chunks) {
      const deleteRequests = chunk.map(item => ({
        DeleteRequest: {
          Key: {
            _pk: item._pk,
            _sk: item._sk
          }
        }
      }));

      await docClient.batchWrite({
        RequestItems: {
          [tableName]: deleteRequests
        }
      });
    }

    console.log(`Successfully deleted ${Items.length} items`);
  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  }

  // Add verification
  await verifyCleanup(docClient, tableName);
}

module.exports = {
  cleanupTestData,
  verifyCleanup
}; 