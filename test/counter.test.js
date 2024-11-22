const { initModels } = require('../src');
const { ModelManager } = require('../src/model-manager');
const { ModelRegistry } = require('../src/model-registry');
const { BaseModel, PrimaryKeyConfig } = require('../src/model');
const { StringField, CounterField } = require('../src/fields');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { verifyCapacityUsage } = require('./dynamoTestUtils');
require('dotenv').config();

class TestCounter extends BaseModel {
  static modelPrefix = 'tc';
  
  static fields = {
    counterId: StringField({ required: true }),
    name: StringField(),
    count: CounterField({ defaultValue: 0 }),
    otherCount: CounterField({ defaultValue: 10 })
  };

  static primaryKey = PrimaryKeyConfig('counterId');
}

describe('Counter Field Tests', () => {
  let testCounter;

  beforeAll(async () => {
    // First initialize the ModelManager
    const manager = ModelManager.getInstance();
    manager.init({
      region: process.env.AWS_REGION,
      tableName: process.env.TABLE_NAME
    });

    // Then register the TestCounter model
    ModelRegistry.getInstance().register(TestCounter);
    
    // Set up the model manually since it's not in the models directory
    TestCounter.documentClient = manager.documentClient;
    TestCounter.table = manager.tableName;
    TestCounter.validateConfiguration();
    TestCounter.registerRelatedIndexes();
  });

  beforeEach(async () => {
    const docClient = ModelManager.getInstance().documentClient;
    await cleanupTestData(docClient, process.env.TABLE_NAME);
    await verifyCleanup(docClient, process.env.TABLE_NAME);

    // Create a new counter for each test
    testCounter = await TestCounter.create({
      counterId: `test-counter-${Date.now()}`, // Make ID unique for each test
      name: 'Test Counter',
      count: 0,
      otherCount: 10
    });
  });

  afterEach(async () => {
    const docClient = ModelManager.getInstance().documentClient;
    await cleanupTestData(docClient, process.env.TABLE_NAME);
    await verifyCleanup(docClient, process.env.TABLE_NAME);
  });

  test('should initialize with default value', async () => {
    const counter = await TestCounter.create({
      counterId: `test-counter-${Date.now()}-2`,
      name: 'Test Counter 2'
    });
    
    // Fetch the counter to verify the values
    const fetchedCounter = await TestCounter.find(counter.counterId);
    
    expect(fetchedCounter.count).toBe(0);
    expect(fetchedCounter.otherCount).toBe(10);
  });

  test('should increment counter atomically', async () => {
    const result = await TestCounter.update(testCounter.counterId, { 
      count: '+1' 
    });
    
    expect(result.count).toBe(1);
  });

  test('should decrement counter atomically', async () => {
    const result = await TestCounter.update(testCounter.counterId, { 
      otherCount: '-5' 
    });
    
    expect(result.otherCount).toBe(5);
  });

  test('should handle multiple counter operations in one update', async () => {
    const result = await TestCounter.update(testCounter.counterId, {
      count: '+5',
      otherCount: '-2'
    });

    expect(result.count).toBe(5);
    expect(result.otherCount).toBe(8);
  });

  test('should allow setting absolute values', async () => {
    const result = await TestCounter.update(testCounter.counterId, {
      count: 42
    });

    expect(result.count).toBe(42);
  });

  test('should handle mixed counter and regular field updates', async () => {
    const result = await TestCounter.update(testCounter.counterId, {
      count: '+1',
      name: 'Updated Counter'
    });

    expect(result.count).toBe(1);
    expect(result.name).toBe('Updated Counter');
  });

  test('should maintain counter value through multiple updates', async () => {
    // First increment
    await TestCounter.update(testCounter.counterId, { count: '+5' });
    
    // Second increment
    await TestCounter.update(testCounter.counterId, { count: '+3' });
    
    // Verify final value
    const finalCounter = await TestCounter.find(testCounter.counterId);
    expect(finalCounter.count).toBe(8);
  });

  test('should handle concurrent increments correctly', async () => {
    // Simulate multiple concurrent increments
    const updates = [];
    for (let i = 0; i < 5; i++) {
      updates.push(TestCounter.update(testCounter.counterId, { count: '+1' }));
    }
    
    // Wait for all updates to complete
    await Promise.all(updates);
    
    // Verify final value
    const finalCounter = await TestCounter.find(testCounter.counterId);
    expect(finalCounter.count).toBe(5);
  });

  test('should validate counter values', async () => {
    // Should reject non-integer values
    await expect(async () => {
      await TestCounter.create({
        counterId: 'test-counter-3',
        count: 3.14
      });
    }).rejects.toThrow('CounterField value must be an integer');
  });
}); 