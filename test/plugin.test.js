const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

let testId;

class TestModel extends BaoModel {
  static modelPrefix = "tm";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    id: StringField({ required: true }),
    name: StringField(),
  };

  static primaryKey = PrimaryKeyConfig("id");
}

describe("Plugin System Tests", () => {
  let testModel;

  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();

      const manager = initTestModelsWithTenant(testConfig, testId);

      manager.registerModel(TestModel);

      if (testId) {
        await cleanupTestDataByIteration(testId, [TestModel]);
        await verifyCleanup(testId, [TestModel]);
      }

      // Create a new instance for each test
      testModel = await TestModel.create({
        id: `test-${Date.now()}`,
        name: "Test Model",
      });
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [TestModel]);
        await verifyCleanup(testId, [TestModel]);
      }
    });
  });

  test("should execute beforeSave and afterSave hooks", async () => {
    await runWithBatchContext(async () => {
      const hookCalls = [];

      const testPlugin = {
        async beforeSave(instance, options) {
          hookCalls.push("beforeSave");
          instance.name = "Modified by beforeSave";
        },
        async afterSave(instance, options) {
          hookCalls.push("afterSave");
        },
      };

      TestModel.registerPlugin(testPlugin);

      // Update the model
      testModel.name = "New Name";
      await testModel.save();

      // Verify hooks were called in order
      expect(hookCalls).toEqual(["beforeSave", "afterSave"]);

      // Verify beforeSave modification was saved
      expect(testModel.name).toBe("Modified by beforeSave");

      // Verify changes persisted to database
      const fetchedModel = await TestModel.find(testModel.id);
      expect(fetchedModel.name).toBe("Modified by beforeSave");
    });
  });

  test("should not execute hooks when no changes to save", async () => {
    await runWithBatchContext(async () => {
      const hookCalls = [];

      const testPlugin = {
        async beforeSave(instance, options) {
          hookCalls.push("beforeSave");
        },
        async afterSave(instance, options) {
          hookCalls.push("afterSave");
        },
      };

      TestModel.registerPlugin(testPlugin);

      // Call save without making changes
      await testModel.save();

      // Verify no hooks were called
      expect(hookCalls).toEqual([]);
    });
  });

  test("should pass options to hooks", async () => {
    await runWithBatchContext(async () => {
      let capturedOptions;

      const testPlugin = {
        async beforeSave(instance, options) {
          capturedOptions = options;
        },
      };

      TestModel.registerPlugin(testPlugin);

      const testOptions = { skipValidation: true };
      testModel.name = "New Name";
      await testModel.save(testOptions);

      expect(capturedOptions).toMatchObject(testOptions);
    });
  });

  test("should support multiple plugins", async () => {
    await runWithBatchContext(async () => {
      const hookCalls = [];

      const plugin1 = {
        async beforeSave(instance, options) {
          hookCalls.push("plugin1:beforeSave");
        },
      };

      const plugin2 = {
        async beforeSave(instance, options) {
          hookCalls.push("plugin2:beforeSave");
        },
      };

      TestModel.registerPlugin(plugin1);
      TestModel.registerPlugin(plugin2);

      testModel.name = "New Name";
      await testModel.save();

      expect(hookCalls).toEqual(["plugin1:beforeSave", "plugin2:beforeSave"]);
    });
  });

  test("should execute beforeDelete and afterDelete hooks", async () => {
    let modelId;

    await runWithBatchContext(async () => {
      const hookCalls = [];
      modelId = testModel.id;

      const testPlugin = {
        async beforeDelete(primaryId, options) {
          hookCalls.push("beforeDelete");
          expect(primaryId).toBe(testModel.id);
        },
        async afterDelete(primaryId, options) {
          hookCalls.push("afterDelete");
          expect(primaryId).toBe(testModel.id);
        },
      };

      TestModel.registerPlugin(testPlugin);

      // Delete the model
      await TestModel.delete(testModel.id);

      // Verify hooks were called in order
      expect(hookCalls).toEqual(["beforeDelete", "afterDelete"]);
    });

    // Use separate batch context to verify deletion
    await runWithBatchContext(async () => {
      const result = await TestModel.find(modelId);
      expect(result.exists()).toBe(false);
    });
  });

  test("should pass options to delete hooks", async () => {
    await runWithBatchContext(async () => {
      let capturedOptions;

      const testPlugin = {
        async beforeDelete(primaryId, options) {
          capturedOptions = options;
        },
      };

      TestModel.registerPlugin(testPlugin);

      const testOptions = { force: true };
      await TestModel.delete(testModel.id, testOptions);

      expect(capturedOptions).toMatchObject(testOptions);
    });
  });
});
