// test/capacity.test.js
const { 
  User, 
  Post,
  GSI_INDEX_ID1, 
  GSI_INDEX_ID2, 
  GSI_INDEX_ID3 
} = require('../src');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { verifyCapacityUsage } = require('./dynamoTestUtils');
require('dotenv').config();

let docClient;

beforeAll(async () => {
  const client = new DynamoDBClient({ region: process.env.AWS_REGION });
  docClient = DynamoDBDocument.from(client);
  
  console.log('AWS Region:', process.env.AWS_REGION);
  console.log('Table Name:', process.env.TABLE_NAME);
  
  User.initTable(docClient, process.env.TABLE_NAME);
});

beforeEach(async () => {
  await cleanupTestData(docClient, process.env.TABLE_NAME);
  await verifyCleanup(docClient, process.env.TABLE_NAME);
});

afterEach(async () => {
  await cleanupTestData(docClient, process.env.TABLE_NAME);
  await verifyCleanup(docClient, process.env.TABLE_NAME);
});

describe('Capacity Usage Tests', () => {
  test('should create user with expected capacity', async () => {
    const result = await verifyCapacityUsage(
      async () => await User.create({
        name: 'Test User 1',
        email: 'test1@example.com'
      }),
      0,    // Expected RCU - transactWrite doesn't count as read
      10.0  // Expected WCU - 2 writes at 5 WCU each in transaction
    );
    expect(result).toBeDefined();
    expect(result.email).toBe('test1@example.com');
  });

  test('should update user without unique field change', async () => {
    // Create a user with all required fields
    const user = await User.create({
      name: 'Test User 1',
      email: 'test1@example.com',
      status: 'active'
    });

    // Wait a moment to ensure timestamps are different
    await new Promise(resolve => setTimeout(resolve, 100));

    const result = await verifyCapacityUsage(
      async () => await User.update(user.id, {
        name: 'Updated Name',
        createdAt: user.createdAt
      }),
      0.5,  // Expected RCU - eventually consistent read for current state
      5.0   // Expected WCU - single write with GSI updates (5 WCU)
    );
    expect(result.name).toBe('Updated Name');
  });

  test('should update user with unique field change', async () => {
    // Create a user with all required fields
    const user = await User.create({
      name: 'Test User 1',
      email: 'test1@example.com',
      status: 'active'
    });

    // Wait a moment to ensure timestamps are different
    await new Promise(resolve => setTimeout(resolve, 100));

    const result = await verifyCapacityUsage(
      async () => await User.update(user.id, {
        email: 'new-email@example.com',
        createdAt: user.createdAt
      }),
      0.5,   // Expected RCU - eventually consistent read for current state
      14.0   // Expected WCU - transaction with 3 operations (delete old unique, create new unique, update item)
    );
    expect(result.email).toBe('new-email@example.com');
  });

  test('should delete user with expected capacity', async () => {
    const user = await User.create({
      name: 'Test User 1',
      email: 'test1@example.com'
    });

    const result = await verifyCapacityUsage(
      async () => await User.delete(user.id),
      0.5,  // Expected RCU - eventually consistent read for current state
      10    // Expected WCU - transaction with 2 operations at 5 WCU each
    );
    expect(result.id).toBe(user.id);
  });
});

describe('Query Capacity Tests', () => {
  test('should efficiently query by index', async () => {
    const user = await User.create({
      name: 'Test User',
      email: 'test@example.com',
      external_id: 'ext1',
      external_platform: 'platform1',
      role: 'user',
      status: 'active'
    });

    const capacityBefore = await sumConsumedCapacity();
    
    await User.queryByIndex('byPlatform', 'platform1');
    await User.queryByIndex('byRole', 'user');
    await User.queryByIndex('byStatus', 'active');
    
    const capacityAfter = await sumConsumedCapacity();
    const capacityUsed = capacityAfter - capacityBefore;

    expect(capacityUsed).toBeLessThanOrEqual(3); // Assuming 1 capacity unit per query
    printCapacityUsage('Index Queries', capacityUsed);
  });
});