const dynamoBao = require('../src');
const testConfig = require('./config');
const { BaseModel, PrimaryKeyConfig } = require('../src/model');
const { StringField } = require('../src/fields');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');

let testId;

class TestModel extends BaseModel {
  static modelPrefix = 'tm';
  
  static fields = {
    id: StringField({ required: true }),
    name: StringField()
  };

  static primaryKey = PrimaryKeyConfig('id');
}

describe('Plugin System Tests', () => {
  let testModel;

  beforeEach(async () => {
    testId = ulid();
  
    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId
    });

    manager.registerModel(TestModel);

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }

    // Create a new instance for each test
    testModel = await TestModel.create({
      id: `test-${Date.now()}`,
      name: 'Test Model'
    });
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test('should execute beforeSave and afterSave hooks', async () => {
    const hookCalls = [];
    
    const testPlugin = {
      async beforeSave(instance, options) {
        hookCalls.push('beforeSave');
        instance.name = 'Modified by beforeSave';
      },
      async afterSave(instance, options) {
        hookCalls.push('afterSave');
      }
    };

    TestModel.registerPlugin(testPlugin);

    // Update the model
    testModel.name = 'New Name';
    await testModel.save();

    // Verify hooks were called in order
    expect(hookCalls).toEqual(['beforeSave', 'afterSave']);
    
    // Verify beforeSave modification was saved
    expect(testModel.name).toBe('Modified by beforeSave');

    // Verify changes persisted to database
    const fetchedModel = await TestModel.find(testModel.id);
    expect(fetchedModel.name).toBe('Modified by beforeSave');
  });

  test('should not execute hooks when no changes to save', async () => {
    const hookCalls = [];
    
    const testPlugin = {
      async beforeSave(instance, options) {
        hookCalls.push('beforeSave');
      },
      async afterSave(instance, options) {
        hookCalls.push('afterSave');
      }
    };

    TestModel.registerPlugin(testPlugin);

    // Call save without making changes
    await testModel.save();

    // Verify no hooks were called
    expect(hookCalls).toEqual([]);
  });

  test('should pass options to hooks', async () => {
    let capturedOptions;
    
    const testPlugin = {
      async beforeSave(instance, options) {
        capturedOptions = options;
      }
    };

    TestModel.registerPlugin(testPlugin);

    const testOptions = { skipValidation: true };
    testModel.name = 'New Name';
    await testModel.save(testOptions);

    expect(capturedOptions).toMatchObject(testOptions);
  });

  test('should support multiple plugins', async () => {
    const hookCalls = [];
    
    const plugin1 = {
      async beforeSave(instance, options) {
        hookCalls.push('plugin1:beforeSave');
      }
    };

    const plugin2 = {
      async beforeSave(instance, options) {
        hookCalls.push('plugin2:beforeSave');
      }
    };

    TestModel.registerPlugin(plugin1);
    TestModel.registerPlugin(plugin2);

    testModel.name = 'New Name';
    await testModel.save();

    expect(hookCalls).toEqual([
      'plugin1:beforeSave',
      'plugin2:beforeSave'
    ]);
  });

  test('should execute beforeDelete and afterDelete hooks', async () => {
    const hookCalls = [];
    
    const testPlugin = {
      async beforeDelete(primaryId, options) {
        hookCalls.push('beforeDelete');
        expect(primaryId).toBe(testModel.id);
      },
      async afterDelete(primaryId, options) {
        hookCalls.push('afterDelete');
        expect(primaryId).toBe(testModel.id);
      }
    };

    TestModel.registerPlugin(testPlugin);

    // Delete the model
    await TestModel.delete(testModel.id);

    // Verify hooks were called in order
    expect(hookCalls).toEqual(['beforeDelete', 'afterDelete']);

    // Verify deletion
    const result = await TestModel.find(testModel.id);
    expect(result.exists()).toBe(false);
  });

  test('should pass options to delete hooks', async () => {
    let capturedOptions;
    
    const testPlugin = {
      async beforeDelete(primaryId, options) {
        capturedOptions = options;
      }
    };

    TestModel.registerPlugin(testPlugin);

    const testOptions = { force: true };
    await TestModel.delete(testModel.id, testOptions);

    expect(capturedOptions).toMatchObject(testOptions);
  });
}); 