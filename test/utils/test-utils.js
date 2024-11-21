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

  let allItems = [];
  let lastEvaluatedKey;

  // Keep scanning until we get all items
  do {
    const scanParams = {
      TableName: tableName,
      FilterExpression: 'begins_with(#pk, :prefix1) OR begins_with(#pk, :prefix2) OR begins_with(#pk, :prefix3) OR begins_with(#pk, :prefix4) OR begins_with(#pk, :prefix5) OR begins_with(#pk, :prefix6)',
      ExpressionAttributeNames: {
        '#pk': '_pk'
      },
      ExpressionAttributeValues: {
        ':prefix1': 'u#',
        ':prefix2': 'p#',
        ':prefix3': 't#',
        ':prefix4': 'tp#',
        ':prefix5': '_raft_uc#',
        ':prefix6': '_raft_uc#'
      },
      ExclusiveStartKey: lastEvaluatedKey
    };

    const { Items = [], LastEvaluatedKey } = await docClient.scan(scanParams);
    allItems = allItems.concat(Items);
    lastEvaluatedKey = LastEvaluatedKey;
  } while (lastEvaluatedKey);

  if (allItems.length === 0) {
    console.log('No test data to clean up');
    return;
  }

  console.log(`Found ${allItems.length} items to delete`);

  // Batch delete items in chunks of 25 (DynamoDB limit)
  const chunks = [];
  for (let i = 0; i < allItems.length; i += 25) {
    chunks.push(allItems.slice(i, i + 25));
  }

  // Process chunks sequentially to avoid overwhelming DynamoDB
  for (const chunk of chunks) {
    const deleteRequests = chunk.map(item => ({
      DeleteRequest: {
        Key: {
          _pk: item._pk,
          _sk: item._sk
        }
      }
    }));

    // Add retries for unprocessed items
    let unprocessedItems;
    do {
      const result = await docClient.batchWrite({
        RequestItems: {
          [tableName]: deleteRequests
        }
      });
      unprocessedItems = result.UnprocessedItems?.[tableName];
      
      if (unprocessedItems?.length > 0) {
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } while (unprocessedItems?.length > 0);
  }

  // Add a small delay before verification to ensure consistency
  await new Promise(resolve => setTimeout(resolve, 500));
  
  console.log(`Successfully deleted ${allItems.length} items`);
  
  // Add verification
  await verifyCleanup(docClient, tableName);
}

module.exports = {
  cleanupTestData,
  verifyCleanup
}; 