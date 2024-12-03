const { initModels } = require('../src');
const { ModelManager } = require('../src/model-manager');
const { BaseModel, PrimaryKeyConfig, IndexConfig, UniqueConstraintConfig, GSI_INDEX_ID1, UNIQUE_CONSTRAINT_ID1 } = require('../src/model');
const { StringField } = require('../src/fields');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');
require('dotenv').config();

let testId;

class TestModel extends BaseModel {
  static modelPrefix = 'tm';
  
  static fields = {
    itemId: StringField({ required: true }),
    name: StringField(),
  };

  static primaryKey = PrimaryKeyConfig('itemId');

  // Add index and unique constraint configurations
  static indexes = {
    byName: IndexConfig('name', 'modelPrefix', GSI_INDEX_ID1)
  };

  static uniqueConstraints = {
    uniqueName: UniqueConstraintConfig('name', UNIQUE_CONSTRAINT_ID1)
  };
}

describe('Invalid Lookup Tests', () => {
  beforeAll(async () => {
    initModels({
      region: process.env.AWS_REGION,
      tableName: process.env.TABLE_NAME
    });
  });

  beforeEach(async () => {
    testId = ulid();
    
    initModels({
      region: process.env.AWS_REGION,
      tableName: process.env.TABLE_NAME,
      test_id: testId
    });

    const manager = ModelManager.getInstance(testId);
    manager.registerModel(TestModel);

    TestModel.documentClient = manager.documentClient;
    TestModel.table = manager.tableName;
    TestModel.validateConfiguration();
    TestModel.registerRelatedIndexes();
    TestModel.registerUniqueConstraintLookups();

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test('should return null when primary key does not exist', async () => {
    const result = await TestModel.find('non-existent-id');
    expect(result).toBeNull();
  });

  test('should return null when sort key does not exist', async () => {
    const nonExistentId = `test-item-${Date.now()}##__SK__##wrong-sk`;
    const result = await TestModel.find(nonExistentId);
    expect(result).toBeNull();
  });

  test('should return null when unique constraint lookup fails', async () => {
    const result = await TestModel.findByName('non-existent-name');
    expect(result).toBeNull();
  });

  test('should return empty array when querying non-existent index value', async () => {
    const result = await TestModel.queryByIndex('byName', 'non-existent-name');
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
  });
}); 