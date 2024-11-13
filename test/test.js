const { BaseModel, User, Post } = require('../src');
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

async function runTest() {
  console.log('Initializing DynamoDB client...');
  
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION,
  });
  const docClient = DynamoDBDocument.from(client);
  
  console.log(`Using region: ${process.env.AWS_REGION}`);
  console.log(`Using table: ${process.env.TABLE_NAME}`);

  try {
    console.log('Initializing table...');
    BaseModel.initTable(docClient, process.env.TABLE_NAME);

    // Clean up any leftover test data
    await cleanupTestData(docClient, process.env.TABLE_NAME);

    // Test User CRUD operations
    console.log('\nTesting User operations:');
    
    // Create
    console.log('Creating user...');
    const userData = {
      name: 'Test User',
      email: 'test@example.com'
    };
    console.log('User data to create:', userData);
    
    const user = await User.create(userData);
    console.log('Created user:', JSON.stringify(user, null, 2));

    if (!user || !user.id) {
      throw new Error('User creation failed - no user or user ID returned');
    }

    // Read
    console.log('\nFinding user...');
    const foundUser = await User.find(user.id);
    console.log('Found user:', JSON.stringify(foundUser, null, 2));

    if (!foundUser) {
      throw new Error('User not found after creation');
    }

    // Test Post creation
    console.log('\nTesting Post operations:');
    const postData = {
      userId: user.id,
      title: 'Test Post',
      content: 'This is a test post'
    };
    console.log('Post data to create:', postData);
    
    const post = await Post.create(postData);
    console.log('Created post:', JSON.stringify(post, null, 2));

    // List all users
    console.log('\nListing all users...');
    const users = await User.findAll();
    console.log('All users:', JSON.stringify(users, null, 2));

    // Update user
    console.log('\nUpdating user...');
    const updateData = {
      name: 'Updated Name'
    };
    console.log('Update data:', updateData);
    
    const updatedUser = await User.update(user.id, updateData);
    console.log('Updated user:', JSON.stringify(updatedUser, null, 2));

    // Test partial update preservation
    console.log('\nTesting partial update preservation...');
    const partialUpdate1 = {
      name: 'First Update'
    };
    const partialUpdate2 = {
      email: 'newemail@example.com'
    };
    
    await User.update(user.id, partialUpdate1);
    const finalUser = await User.update(user.id, partialUpdate2);
    
    // Verify both updates are preserved
    if (finalUser.name !== 'First Update' || finalUser.email !== 'newemail@example.com') {
      throw new Error('Partial updates did not preserve all fields correctly');
    }
    console.log('Partial update test passed');

    // Delete user
    console.log('\nDeleting user...');
    await User.delete(user.id);
    console.log('User deleted successfully');

    // Verify deletion
    const deletedUser = await User.find(user.id);
    if (deletedUser) {
      throw new Error('User still exists after deletion');
    }

    // Final cleanup
    await cleanupTestData(docClient, process.env.TABLE_NAME);

    console.log('\nAll tests completed successfully!');
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

// Run the test
console.log('Starting tests...');
runTest();