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

class TestRequireModel extends BaoModel {
  static modelPrefix = "trm";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    itemId: StringField({ required: true }),
    name: StringField({ required: true }),
  };

  static primaryKey = PrimaryKeyConfig("itemId");
}

describe("Require Batch Context Configuration", () => {
  beforeEach(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);
    manager.registerModel(TestRequireModel);

    await runWithBatchContext(async () => {
      await cleanupTestDataByIteration(testId, [TestRequireModel]);
      await verifyCleanup(testId, [TestRequireModel]);
    });
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await runWithBatchContext(async () => {
        await cleanupTestDataByIteration(testId, [TestRequireModel]);
        await verifyCleanup(testId, [TestRequireModel]);
      });
    }
  });

  describe("requireBatchContext: false (default behavior)", () => {
    test("should work inside runWithBatchContext", async () => {
      const manager = initTestModelsWithTenant(
        {
          ...testConfig,
          batchContext: { requireBatchContext: false },
        },
        testId,
      );
      const TestModel = manager.getModel("TestRequireModel");

      await runWithBatchContext(async () => {
        const item = await TestModel.create({
          itemId: `test-${Date.now()}`,
          name: "Test Item",
        });

        const foundItem = await TestModel.find(item.itemId);
        expect(foundItem.name).toBe("Test Item");
      });
    });

    test("should work outside runWithBatchContext with direct execution", async () => {
      const manager = initTestModelsWithTenant(
        {
          ...testConfig,
          batchContext: { requireBatchContext: false },
        },
        testId,
      );
      const TestModel = manager.getModel("TestRequireModel");

      // Create item inside batch context
      let itemId;
      await runWithBatchContext(async () => {
        const item = await TestModel.create({
          itemId: `test-${Date.now()}`,
          name: "Test Item Outside",
        });
        itemId = item.itemId;
      });

      // Find item outside batch context - should work with direct execution
      const foundItem = await TestModel.find(itemId);
      expect(foundItem.name).toBe("Test Item Outside");
      expect(foundItem.exists()).toBe(true);
    });

    test("should not use caching outside batch context", async () => {
      const manager = initTestModelsWithTenant(
        {
          ...testConfig,
          batchContext: { requireBatchContext: false },
        },
        testId,
      );
      const TestModel = manager.getModel("TestRequireModel");

      // Create item inside batch context
      let itemId;
      await runWithBatchContext(async () => {
        const item = await TestModel.create({
          itemId: `test-${Date.now()}`,
          name: "Test Item Cache",
        });
        itemId = item.itemId;
      });

      // Find item twice outside batch context - should get different object instances
      const foundItem1 = await TestModel.find(itemId);
      const foundItem2 = await TestModel.find(itemId);

      expect(foundItem1.name).toBe("Test Item Cache");
      expect(foundItem2.name).toBe("Test Item Cache");
      // Should be different object instances (no caching)
      expect(foundItem1).not.toBe(foundItem2);
    });

    test("should detect batch context correctly", async () => {
      const manager = initTestModelsWithTenant(
        {
          ...testConfig,
          batchContext: { requireBatchContext: false },
        },
        testId,
      );
      const TestModel = manager.getModel("TestRequireModel");

      // Outside batch context
      expect(TestModel.isInsideBatchContext()).toBe(false);

      // Inside batch context
      await runWithBatchContext(async () => {
        expect(TestModel.isInsideBatchContext()).toBe(true);
      });

      // Outside again
      expect(TestModel.isInsideBatchContext()).toBe(false);
    });
  });

  describe("requireBatchContext: true (strict mode)", () => {
    test("should work inside runWithBatchContext", async () => {
      const manager = initTestModelsWithTenant(
        {
          ...testConfig,
          batchContext: { requireBatchContext: true },
        },
        testId,
      );
      const TestModel = manager.getModel("TestRequireModel");

      await runWithBatchContext(async () => {
        const item = await TestModel.create({
          itemId: `test-${Date.now()}`,
          name: "Test Item Strict",
        });

        const foundItem = await TestModel.find(item.itemId);
        expect(foundItem.name).toBe("Test Item Strict");
      });
    });

    test("should throw error outside runWithBatchContext", async () => {
      const manager = initTestModelsWithTenant(
        {
          ...testConfig,
          batchContext: { requireBatchContext: true },
        },
        testId,
      );
      const TestModel = manager.getModel("TestRequireModel");

      // Create item inside batch context first
      let itemId;
      await runWithBatchContext(async () => {
        const item = await TestModel.create({
          itemId: `test-${Date.now()}`,
          name: "Test Item Error",
        });
        itemId = item.itemId;
      });

      // Try to find outside batch context - should throw error
      await expect(TestModel.find(itemId)).rejects.toThrow(
        "Batch operations must be executed within runWithBatchContext()",
      );
    });

    test("should throw error for batchFind outside runWithBatchContext", async () => {
      const manager = initTestModelsWithTenant(
        {
          ...testConfig,
          batchContext: { requireBatchContext: true },
        },
        testId,
      );
      const TestModel = manager.getModel("TestRequireModel");

      // Try to batchFind outside batch context - should throw error
      await expect(TestModel.batchFind(["non-existent-id"])).rejects.toThrow(
        "Batch operations must be executed within runWithBatchContext()",
      );
    });

    test("should detect batch context correctly in strict mode", async () => {
      const manager = initTestModelsWithTenant(
        {
          ...testConfig,
          batchContext: { requireBatchContext: true },
        },
        testId,
      );
      const TestModel = manager.getModel("TestRequireModel");

      // Outside batch context
      expect(TestModel.isInsideBatchContext()).toBe(false);

      // Inside batch context
      await runWithBatchContext(async () => {
        expect(TestModel.isInsideBatchContext()).toBe(true);
      });

      // Outside again
      expect(TestModel.isInsideBatchContext()).toBe(false);
    });
  });
});
