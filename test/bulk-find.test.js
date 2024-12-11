const dynamoBao = require('../src');
const testConfig = require('./config');
const { BaseModel, PrimaryKeyConfig } = require('../src/model');
const { StringField } = require('../src/fields');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');

let testId;

class TestBulkModel extends BaseModel {
  static modelPrefix = 'tbm';
  
  static fields = {
    itemId: StringField({ required: true }),
    name: StringField({ required: true })
  };

  static primaryKey = PrimaryKeyConfig('itemId');
}

describe('batchFind Tests', () => {
  let items = [];
  let loaderContext = {};

  beforeEach(async () => {
    testId = ulid();
    loaderContext = {};
  
    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId
    });

    manager.registerModel(TestBulkModel);

    if (testId) {
        await cleanupTestData(testId);
        await verifyCleanup(testId);
    }

    // Create multiple test items
    items = await Promise.all([
      TestBulkModel.create({
        itemId: `test-item-1-${Date.now()}`,
        name: 'Test Item 1'
      }),
      TestBulkModel.create({
        itemId: `test-item-2-${Date.now()}`,
        name: 'Test Item 2'
      }),
      TestBulkModel.create({
        itemId: `test-item-3-${Date.now()}`,
        name: 'Test Item 3'
      })
    ]);
  });

  afterEach(async () => {
    if (testId) {
        await cleanupTestData(testId);
        await verifyCleanup(testId);
    }
  });

  test('should load multiple items efficiently', async () => {
    const itemIds = items.map(item => item.getPrimaryId());
    
    // First bulk load - should hit DynamoDB
    const result1 = await TestBulkModel.batchFind(itemIds, loaderContext);
    
    // Verify all items were loaded
    expect(Object.keys(result1.items).length).toBe(3);
    expect(result1.ConsumedCapacity.length).toBeGreaterThan(0);
    
    // Verify items are in the loader context
    itemIds.forEach(id => {
      expect(loaderContext[id]).toBeDefined();
      expect(loaderContext[id].name).toMatch(/Test Item \d/);
    });
  });

  test('should use cache for subsequent loads', async () => {
    const itemIds = items.map(item => item.getPrimaryId());
    
    // First bulk load - should hit DynamoDB
    const result1 = await TestBulkModel.batchFind(itemIds, loaderContext);
    expect(result1.ConsumedCapacity.length).toBeGreaterThan(0);
    
    // Second bulk load - should use cache
    const result2 = await TestBulkModel.batchFind(itemIds, loaderContext);
    expect(result2.ConsumedCapacity.length).toBe(0);
    
    // Verify same items returned (sort keys for stable comparison)
    expect(Object.keys(result2.items).sort())
      .toEqual(Object.keys(result1.items).sort());
    
    // Verify the actual items are the same
    Object.keys(result1.items).forEach(id => {
      expect(result2.items[id].name).toBe(result1.items[id].name);
    });
  });

  test('should handle mixed cache hits and misses', async () => {
    const firstTwoIds = items.slice(0, 2).map(item => item.getPrimaryId());
    const allIds = items.map(item => item.getPrimaryId());
    
    // Load first two items
    const result1 = await TestBulkModel.batchFind(firstTwoIds, loaderContext);
    expect(result1.ConsumedCapacity.length).toBeGreaterThan(0);
    expect(Object.keys(result1.items).length).toBe(2);
    
    // Load all items - should only hit DynamoDB for the third item
    const result2 = await TestBulkModel.batchFind(allIds, loaderContext);
    expect(result2.ConsumedCapacity.length).toBeGreaterThan(0);
    expect(Object.keys(result2.items).length).toBe(3);
  });

  test('should handle empty input gracefully', async () => {
    const result = await TestBulkModel.batchFind([], loaderContext);
    expect(result.items).toEqual({});
    expect(result.ConsumedCapacity).toEqual([]);
  });

  test('should handle null input gracefully', async () => {
    const result = await TestBulkModel.batchFind(null, loaderContext);
    expect(result.items).toEqual({});
    expect(result.ConsumedCapacity).toEqual([]);
  });

  test('should work without loader context', async () => {
    const itemIds = items.map(item => item.getPrimaryId());
    
    const result = await TestBulkModel.batchFind(itemIds);
    expect(Object.keys(result.items).length).toBe(3);
    expect(result.ConsumedCapacity.length).toBeGreaterThan(0);
  });

  test('should handle large batches correctly', async () => {
    // Create 120 items (still exceeds DynamoDB's batch limit of 100)
    const itemPromises = [];
    for (let i = 0; i < 120; i++) {
      itemPromises.push(TestBulkModel.create({
        itemId: `bulk-test-${i}-${Date.now()}`,
        name: `Bulk Test Item ${i}`
      }));
    }
    
    const manyItems = await Promise.all(itemPromises);
    const manyIds = manyItems.map(item => item.getPrimaryId());
    
    // Load all items
    const result = await TestBulkModel.batchFind(manyIds, loaderContext);
    
    // Verify all items were loaded
    expect(Object.keys(result.items).length).toBe(120);
    
    // Should have multiple capacity entries due to multiple batches
    expect(result.ConsumedCapacity.length).toBeGreaterThan(1);
    
    // Load again from cache
    const cachedResult = await TestBulkModel.batchFind(manyIds, loaderContext);
    expect(Object.keys(cachedResult.items).length).toBe(120);
    expect(cachedResult.ConsumedCapacity.length).toBe(0);
  }, 10000); // Still keep a higher timeout just in case
}); 