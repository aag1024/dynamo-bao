const { 
    initModels,
    ModelManager,
    User,
  } = require('../src');
const { DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
require('dotenv').config();

let testId;

beforeAll(async () => {
  // Initialize models
  initModels({
    region: process.env.AWS_REGION,
    tableName: process.env.TABLE_NAME
  });

  const docClient = ModelManager.getInstance().documentClient;
  
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
});

beforeEach(async () => {
  testId = ulid();
  
  initModels({
    region: process.env.AWS_REGION,
    tableName: process.env.TABLE_NAME,
    test_id: testId
  });

  await cleanupTestData(testId);
  await verifyCleanup(testId);
});

afterEach(async () => {
  if (testId) {
    await cleanupTestData(testId);
    await verifyCleanup(testId);
  }
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
      
      // Compare only the input fields that we explicitly provided
      expect(user.name).toBe(userData.name);
      expect(user.email).toBe(userData.email);
      expect(user.external_id).toBe(userData.external_id);
      expect(user.external_platform).toBe(userData.external_platform);
      
      // Verify date fields are Date instances
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.modifiedAt).toBeInstanceOf(Date);
      
      // Verify other auto-generated fields
      expect(user.userId).toBeDefined();
      expect(user.role).toBe('user');
      expect(user.status).toBe('active');
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
    await User.delete(user.userId);
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

  test('should query users by platform using byPlatform index', async () => {
    const platformUsers = await User.queryByIndex('byPlatform', 'platform1');
    expect(platformUsers.items).toHaveLength(2);
    expect(platformUsers.items[0].external_platform).toBe('platform1');
  });

  test('should query users by role using byRole index', async () => {
    const adminUsers = await User.queryByIndex('byRole', 'admin');
    expect(adminUsers.items).toHaveLength(1);
    expect(adminUsers.items[0].role).toBe('admin');
  });

  test('should query users by status using byStatus index', async () => {
    const activeUsers = await User.queryByIndex('byStatus', 'active');
    expect(activeUsers.items).toHaveLength(2);
    expect(activeUsers.items[0].status).toBe('active');
  });

  test('should throw error for invalid index name', async () => {
    await expect(
      User.queryByIndex('invalidIndex', 'someValue')
    ).rejects.toThrow('Index "invalidIndex" not found in User model');
  });
});

describe('Date Range Queries', () => {
  test('should query users by date range', async () => {
    const startDate = new Date();
    await Promise.all([
      User.create({
        name: 'Test User 1',
        email: 'test1@example.com',
        external_id: 'ext1',
        external_platform: 'platform1',
        status: 'active'
      }),
      User.create({
        name: 'Test User 2',
        email: 'test2@example.com',
        external_id: 'ext2',
        external_platform: 'platform1',
        status: 'active'
      })
    ]);
    const endDate = new Date();

    const result = await User.queryByIndex('byStatus', 'active', {
      skValue: { between: [startDate, endDate] }
    });

    expect(result.items.length).toBeGreaterThan(0);
    result.items.forEach(user => {
      expect(user.status).toBe('active');
      // Convert dates to timestamps for comparison
      const userCreatedAt = user.createdAt.getTime();
      const startTimestamp = startDate.getTime();
      const endTimestamp = endDate.getTime();
      
      expect(userCreatedAt).toBeGreaterThanOrEqual(startTimestamp);
      expect(userCreatedAt).toBeLessThanOrEqual(endTimestamp);
    });
  });
});

test('should properly set test_id on models', async () => {
  initModels({
    region: process.env.AWS_REGION,
    tableName: process.env.TABLE_NAME,
    test_id: testId
  });

  const user = await User.create({
    name: 'Test User',
    email: 'test@example.com',
    external_id: 'ext1',
    external_platform: 'platform1'
  });

  const manager = ModelManager.getInstance(testId);
  const docClient = manager.documentClient;
  const result = await docClient.send(new QueryCommand({
    TableName: process.env.TABLE_NAME,
    IndexName: 'gsi_test',
    KeyConditionExpression: '#testId = :testId',
    ExpressionAttributeNames: {
      '#testId': '_gsi_test_id'
    },
    ExpressionAttributeValues: {
      ':testId': testId
    }
  }));

  expect(result.Items.length).toBe(3);
  result.Items.forEach(item => {
    expect(item._gsi_test_id).toBe(testId);
  });
});
