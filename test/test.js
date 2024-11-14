const { 
    User, 
    Post,
    GSI_INDEX_ID1, 
    GSI_INDEX_ID2, 
    GSI_INDEX_ID3 
  } = require('../src');
const { DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
require('dotenv').config();

let docClient;
let testUsers = [];

beforeAll(async () => {
  const client = new DynamoDBClient({ region: process.env.AWS_REGION });
  docClient = DynamoDBDocument.from(client);
  
  console.log('AWS Region:', process.env.AWS_REGION);
  console.log('Table Name:', process.env.TABLE_NAME);
  
  try {
    const tableInfo = await docClient.send(new DescribeTableCommand({
      TableName: process.env.TABLE_NAME
    }));
    console.log('Table exists:', tableInfo.Table.TableName);
    console.log('GSIs:', tableInfo.Table.GlobalSecondaryIndexes);
  } catch (error) {
    console.error('Failed to connect to DynamoDB:', error);
    throw error;
  }
  
  User.initTable(docClient, process.env.TABLE_NAME);
  Post.initTable(docClient, process.env.TABLE_NAME);
});

beforeEach(async () => {
  await cleanupTestData(docClient, process.env.TABLE_NAME);
  // Verify cleanup worked
  await verifyCleanup(docClient, process.env.TABLE_NAME);
});

afterEach(async () => {
  await cleanupTestData(docClient, process.env.TABLE_NAME);
  // Verify cleanup worked
  await verifyCleanup(docClient, process.env.TABLE_NAME);
});

describe('User CRUD Operations', () => {
  test('should create a user successfully', async () => {
    const userData = {
      name: 'Test User 1',
      email: 'test1@example.com',
      external_id: 'ext1',
      external_platform: 'platform1'
    };

    console.log('Creating user with data:', userData);
    
    try {
      const user = await User.create(userData);
      console.log('Created user:', user);
      expect(user).toMatchObject(userData);
    } catch (error) {
      console.error('Transaction error details:', error);
      console.error('Cancellation reasons:', error.CancellationReasons);
      throw error;
    }
  });

  test('should prevent duplicate email creation', async () => {
    const userData = {
      name: 'Test User 1',
      email: 'test1@example.com',
      external_id: 'ext1'
    };

    await User.create(userData);

    await expect(async () => {
      await User.create({
        name: 'Test User 2',
        email: 'test1@example.com',
        external_id: 'ext2'
      });
    }).rejects.toThrow('email must be unique');
  });
});

describe('User Unique Constraints', () => {
  test('should allow reusing unique values after user deletion', async () => {
    const userData = {
      name: 'Test User',
      email: 'test@example.com',
      external_id: 'ext1'
    };

    const user = await User.create(userData);
    await User.delete(user.id);

    const newUser = await User.create({
      name: 'New Test User',
      email: 'test@example.com',
      external_id: 'ext1'
    });

    expect(newUser.email).toBe('test@example.com');
    expect(newUser.external_id).toBe('ext1');
  });
});

describe('GSI Queries', () => {
  beforeEach(async () => {
    // Create test users for GSI queries
    testUsers = await Promise.all([
      User.create({
        name: 'Test User 1',
        email: 'test1@example.com',
        external_id: 'ext1',
        external_platform: 'platform1',
        role: 'admin',
        status: 'active'
      }),
      User.create({
        name: 'Test User 2',
        email: 'test2@example.com',
        external_id: 'ext2',
        external_platform: 'platform1',
        role: 'user',
        status: 'active'
      }),
      User.create({
        name: 'Test User 3',
        email: 'test3@example.com',
        external_id: 'ext3',
        external_platform: 'platform2',
        role: 'user',
        status: 'inactive'
      })
    ]);
  });

  test('should query users by platform using GSI1', async () => {
    const platformUsers = await User.queryByIndex(1, 'platform1');
    expect(platformUsers.Items).toHaveLength(2);
    expect(platformUsers.Items[0].external_platform).toBe('platform1');
  });

  test('should query users by role using GSI2', async () => {
    const adminUsers = await User.queryByIndex(2, 'admin');
    expect(adminUsers.Items).toHaveLength(1);
    expect(adminUsers.Items[0].role).toBe('admin');
  });

  test('should query users by status using GSI3', async () => {
    const activeUsers = await User.queryByIndex(3, 'active');
    expect(activeUsers.Items).toHaveLength(2);
    expect(activeUsers.Items[0].status).toBe('active');
  });
});

describe('Date Range Queries', () => {
  it('should query users by date range', async () => {
    // Create a user with status "active"
    const recentUser = await User.create({
      name: 'Recent User',
      email: 'recent@example.com',
      external_id: 'ext4',
      status: 'active'
    });

    // Query users by status and date range using GSI3
    const result = await User.queryByIndex(3, 'active', {
      skValue: '2024-01-01T00:00:00.000Z' // Start date for the range query
    });

    expect(result.Items).toBeDefined();
    expect(result.Items.length).toBeGreaterThan(0);
    expect(result.Items[0].status).toBe('active');
    
    // Compare timestamps instead of Date objects
    const startTimestamp = new Date('2024-01-01').getTime();
    const itemTimestamp = new Date(result.Items[0].createdAt).getTime();
    expect(itemTimestamp).toBeGreaterThan(startTimestamp);
  });
});

describe('Test Utils', () => {
  test('cleanup should remove all test data', async () => {
    // Create some test data
    await User.create({
      name: 'Test User',
      email: 'test@example.com',
      external_id: 'ext1'
    });

    // Run cleanup
    await cleanupTestData(docClient, process.env.TABLE_NAME);

    // Verify cleanup
    const scanResult = await docClient.scan({
      TableName: process.env.TABLE_NAME,
      FilterExpression: 'begins_with(#pk, :prefix1) OR begins_with(#pk, :prefix2)',
      ExpressionAttributeNames: {
        '#pk': '_pk'
      },
      ExpressionAttributeValues: {
        ':prefix1': 'user##',
        ':prefix2': '_raft_uc##'
      }
    });

    expect(scanResult.Items).toHaveLength(0);
  });
});