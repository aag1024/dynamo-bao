async function verifyCleanup(docClient, tableName) {
  const scanResult = await docClient.scan({
    TableName: tableName,
    FilterExpression: 'begins_with(#pk, :prefix1) OR begins_with(#pk, :prefix2) OR begins_with(#pk, :prefix3)',
    ExpressionAttributeNames: {
      '#pk': '_pk'
    },
    ExpressionAttributeValues: {
      ':prefix1': 'u#',
      ':prefix2': '_raft_uc#',
      ':prefix3': 'u#'
    }
  });

  if (scanResult.Items.length > 0) {
    console.log('Warning: Found items after cleanup:', scanResult.Items);
    throw new Error('Cleanup verification failed');
  }
}

async function cleanupTestData(docClient, tableName) {
  console.log('\nCleaning up test data...');

  // Scan for all items that match our test patterns
  const scanParams = {
    TableName: tableName,
    FilterExpression: 'begins_with(#pk, :prefix1) OR begins_with(#pk, :prefix2) OR begins_with(#pk, :prefix3)',
    ExpressionAttributeNames: {
      '#pk': '_pk'
    },
    ExpressionAttributeValues: {
      ':prefix1': 'u#',
      ':prefix2': '_raft_uc#',
      ':prefix3': 'u#'
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