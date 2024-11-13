// test/capacity.test.js
const { BaseModel, User } = require('../src');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { verifyCapacityUsage } = require('./dynamoTestUtils');
require('dotenv').config();

async function cleanupTestData(docClient, tableName) {
  console.log('\nCleaning up test data...');

  try {
    // First get all test users using GSI1
    const userResult = await docClient.query({
      TableName: tableName,
      IndexName: 'gsi1',
      KeyConditionExpression: '#pk = :prefix',
      ExpressionAttributeNames: {
        '#pk': 'gsi1pk'
      },
      ExpressionAttributeValues: {
        ':prefix': 'user'
      }
    });

    // Get all unique constraints using begins_with on PK
    const constraintResult = await docClient.scan({
      TableName: tableName,
      FilterExpression: 'begins_with(#pk, :prefix)',
      ExpressionAttributeNames: {
        '#pk': 'pk'
      },
      ExpressionAttributeValues: {
        ':prefix': '_raft_uc##user:email:'
      }
    });

    const deleteRequests = [];

    // Add user deletions to requests
    if (userResult.Items && userResult.Items.length > 0) {
      console.log(`Found ${userResult.Items.length} test users to clean up`);
      userResult.Items.forEach(item => {
        deleteRequests.push({
          DeleteRequest: {
            Key: {
              pk: item.pk,
              sk: item.sk
            }
          }
        });
      });
    }

    // Add constraint deletions to requests
    if (constraintResult.Items && constraintResult.Items.length > 0) {
      console.log(`Found ${constraintResult.Items.length} unique constraints to clean up`);
      constraintResult.Items.forEach(item => {
        deleteRequests.push({
          DeleteRequest: {
            Key: {
              pk: item.pk,
              sk: item.sk
            }
          }
        });
      });
    }

    // Process delete requests in batches of 25 (DynamoDB limit)
    if (deleteRequests.length > 0) {
      for (let i = 0; i < deleteRequests.length; i += 25) {
        const batch = deleteRequests.slice(i, i + 25);
        await docClient.batchWrite({
          RequestItems: {
            [tableName]: batch
          }
        });
      }
      console.log(`Cleaned up ${deleteRequests.length} items`);
    } else {
      console.log('No test data to clean up');
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  }
}


async function testCapacityUsage() {
    console.log('Starting capacity usage tests...');
    
    const client = new DynamoDBClient({
      region: process.env.AWS_REGION,
    });
    const docClient = DynamoDBDocument.from(client);
    
    try {
      console.log('Initializing table...');
      BaseModel.initTable(docClient, process.env.TABLE_NAME);
  
      // Clean up any existing test data
      await cleanupTestData(docClient, process.env.TABLE_NAME);
  
      let userId;
  
      // Test 1: Create user with unique email
      console.log('\nTest 1: Creating user with unique email');
      const user = await verifyCapacityUsage(
        async () => await User.create({
          name: 'Test User 1',
          email: 'test1@example.com'
        }),
        0,    // Expected RCU - transactWrite doesn't count as read
        6.0   // Expected WCU - 2 writes at 3 WCU each in transaction
      );
      userId = user.id;
  
      // Test 2: Update user without changing unique field
      console.log('\nTest 2: Updating user without changing unique field');
      await verifyCapacityUsage(
        async () => await User.update(userId, {
          name: 'Updated Name'
        }),
        0.5,  // Expected RCU - eventually consistent read for current state
        2     // Expected WCU - standard update operation
      );
  
      // Test 3: Update user with unique field change
      console.log('\nTest 3: Updating user with unique field change');
      await verifyCapacityUsage(
        async () => await User.update(userId, {
          email: 'new-email@example.com'
        }),
        0.5,  // Expected RCU - eventually consistent read for current state
        8     // Expected WCU - transaction with 3 operations at ~2.67 WCU each
      );
  
      // Test 4: Delete user with unique constraints
      console.log('\nTest 4: Deleting user with unique constraints');
      await verifyCapacityUsage(
        async () => await User.delete(userId),
        0.5,  // Expected RCU - eventually consistent read for current state
        6     // Expected WCU - transaction with 2 operations at 3 WCU each
      );
  
      // Final cleanup
      await cleanupTestData(docClient, process.env.TABLE_NAME);
  
      console.log('\nAll capacity tests completed successfully!');
    } catch (error) {
      console.error('Test error:', error);
  
      // Attempt cleanup even if tests fail
      try {
        await cleanupTestData(docClient, process.env.TABLE_NAME);
      } catch (cleanupError) {
        console.error('Error during cleanup after test failure:', cleanupError);
      }
  
      process.exit(1);
    }
  }

// Run the tests
testCapacityUsage();