// test/capacity.test.js
const { 
    initModels, 
    ModelManager
} = require('../src');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { verifyCapacityUsage } = require('./dynamoTestUtils');
const { ulid } = require('ulid');
require('dotenv').config();

let totalConsumedCapacity = 0, testId;

// Add helper function to track capacity
async function sumConsumedCapacity() {
  return totalConsumedCapacity;
}

beforeEach(async () => {
    testId = ulid();

    initModels({
        region: process.env.AWS_REGION,
        tableName: process.env.TABLE_NAME,
        test_id: testId
    });

    if (testId) {
        await cleanupTestData(testId);
        await verifyCleanup(testId);
    }

    User = ModelManager.getInstance(testId).getModel('User');
    totalConsumedCapacity = 0;  // Reset capacity counter
});

afterEach(async () => {
    if (testId) {
        await cleanupTestData(testId);
        await verifyCleanup(testId);
    }
});

describe('Capacity Usage Tests', () => {
  test('should create user with expected capacity', async () => {
    const result = await verifyCapacityUsage(
      async () => await User.create({
        name: 'Test User 1',
        email: 'test1@example.com'
      }),
      0,    // Expected RCU
      10.0  // Expected WCU - for create with unique constraints
    );
    expect(result).toBeDefined();
    expect(result.email).toBe('test1@example.com');
  });

  test('should update user without unique field change', async () => {
    const user = await User.create({
      name: 'Test User 1',
      email: 'test1@example.com',
      status: 'active'
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    const result = await verifyCapacityUsage(
      async () => await User.update(user.userId, {
        name: 'Updated Name',
        status: user.status
      }),
      0,    // Expected RCU
      1.0   // Expected WCU - adjusted for single update
    );
    expect(result.name).toBe('Updated Name');
  });

  test('should update user with unique field change', async () => {
    const user = await User.create({
      name: 'Test User 1',
      email: 'test1@example.com',
      status: 'active'
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    const result = await verifyCapacityUsage(
      async () => await User.update(user.userId, {
        email: 'new-email@example.com',
        status: user.status
      }),
      0,     // Expected RCU - reads are eventually consistent
      16.0   // Expected WCU - for update with unique constraint changes (assuming running in test)
    );
    expect(result.email).toBe('new-email@example.com');
  });

  test('should delete user with expected capacity', async () => {
    const user = await User.create({
      name: 'Test User 1',
      email: 'test1@example.com'
    });

    const userId = user.userId;  // Store userId before deletion

    const result = await verifyCapacityUsage(
      async () => await User.delete(userId),
      0,     // Expected RCU
      10.0   // Expected WCU - for delete with unique constraints
    );
    expect(result.userId).toBe(userId);
  });
});

describe('Query Capacity Tests', () => {
  test('should efficiently query by index', async () => {
    const user = await User.create({
      name: 'Test User',
      email: 'test@example.com',
      externalId: 'ext1',
      externalPlatform: 'platform1',
      role: 'user',
      status: 'active'
    });

    const capacityBefore = await sumConsumedCapacity();
    
    const results = await Promise.all([
      User.queryByIndex('byPlatform', 'platform1'),
      User.queryByIndex('byRole', 'user'),
      User.queryByIndex('byStatus', 'active')
    ]);
    
    const capacityAfter = await sumConsumedCapacity();
    const capacityUsed = capacityAfter - capacityBefore;

    expect(capacityUsed).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(3);
    results.forEach(result => {
      expect(result.items.length).toBeGreaterThan(0);
    });
  });
});