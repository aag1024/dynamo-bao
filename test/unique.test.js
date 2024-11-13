// test/unique.test.js
const { BaseModel, User } = require('../src');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
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

async function testUniqueConstraints() {
  console.log('Starting unique constraint tests...');
  
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION,
  });
  const docClient = DynamoDBDocument.from(client);
  
  try {
    console.log('Initializing table...');
    const table = BaseModel.initTable(docClient, process.env.TABLE_NAME);

    // Clean up any leftover test data
    await cleanupTestData(docClient, process.env.TABLE_NAME);
    
    // Test 1: Create user with unique email
    console.log('\nTest 1: Creating first user with unique email');
    const user1Data = {
      name: 'Test User 1',
      email: 'test1@example.com'
    };
    const user1 = await User.create(user1Data);
    console.log('Created user 1:', JSON.stringify(user1, null, 2));

    // Test 2: Try to create another user with the same email
    console.log('\nTest 2: Attempting to create second user with same email');
    const user2Data = {
      name: 'Test User 2',
      email: 'test1@example.com'  // Same email as user1
    };
    try {
      const user2 = await User.create(user2Data);
      throw new Error('Should not be able to create user with duplicate email');
    } catch (error) {
      if (error.message === 'email must be unique') {
        console.log('Successfully prevented duplicate email creation');
      } else {
        throw error;
      }
    }

    // Test 3: Create another user with different email
    console.log('\nTest 3: Creating second user with different email');
    const user3Data = {
      name: 'Test User 3',
      email: 'test3@example.com'
    };
    const user3 = await User.create(user3Data);
    console.log('Created user 3:', JSON.stringify(user3, null, 2));

    // Test 4: Update user with unique email
    console.log('\nTest 4: Updating user with new unique email');
    const updateData = {
      email: 'test4@example.com'
    };
    const updatedUser = await User.update(user1.id, updateData);
    console.log('Updated user:', JSON.stringify(updatedUser, null, 2));

    // Test 5: Try to update user with existing email
    console.log('\nTest 5: Attempting to update user with existing email');
    try {
      await User.update(user1.id, { email: 'test3@example.com' });
      throw new Error('Should not be able to update user with existing email');
    } catch (error) {
      if (error.message === 'email must be unique') {
        console.log('Successfully prevented duplicate email update');
      } else {
        throw error;
      }
    }

    // Test 6: Delete user and verify constraint is removed
    console.log('\nTest 6: Deleting user and verifying constraint removal');
    await User.delete(user1.id);
    
    // Try to create new user with the deleted user's original email
    const user4Data = {
      name: 'Test User 4',
      email: 'test4@example.com'  // Previously used by user1
    };
    const user4 = await User.create(user4Data);
    console.log('Successfully created user with previously used email');

    // Final cleanup
    console.log('\nFinal cleanup...');
    await User.delete(user3.id);
    await User.delete(user4.id);
    await cleanupTestData(docClient, process.env.TABLE_NAME);

    console.log('\nAll unique constraint tests completed successfully!');
  } catch (error) {
    console.error('Test error:', {
      message: error.message,
      code: error.code,
      name: error.name,
      stack: error.stack
    });

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
testUniqueConstraints();