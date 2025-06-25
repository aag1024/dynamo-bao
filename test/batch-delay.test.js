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

class TestBatchModel extends BaoModel {
  static modelPrefix = "tbm";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    itemId: StringField({ required: true }),
    name: StringField({ required: true }),
    value: StringField(),
  };

  static primaryKey = PrimaryKeyConfig("itemId");
}

describe("Batch Delay Tests", () => {
  let testItems = [];

  beforeEach(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    manager.registerModel(TestBatchModel);

    if (testId) {
      await cleanupTestDataByIteration(testId, [TestBatchModel]);
      await verifyCleanup(testId, [TestBatchModel]);
    }

    // Create test items within batch context
    testItems = await runWithBatchContext(async () => {
      return await Promise.all([
        TestBatchModel.create({
          itemId: `test-item-1-${Date.now()}`,
          name: "Test Item 1",
          value: "a",
        }),
        TestBatchModel.create({
          itemId: `test-item-2-${Date.now()}`,
          name: "Test Item 2",
          value: "b",
        }),
        TestBatchModel.create({
          itemId: `test-item-3-${Date.now()}`,
          name: "Test Item 3",
          value: "c",
        }),
      ]);
    });
  });

  afterEach(async () => {
    TenantContext.clearTenant();

    if (testId) {
      await cleanupTestDataByIteration(testId, [TestBatchModel]);
      await verifyCleanup(testId, [TestBatchModel]);
    }
  });

  test("should make individual requests with delay=0", async () => {
    await runWithBatchContext(async () => {
      const item1 = await TestBatchModel.find(testItems[0].getPrimaryId(), {
        batchDelay: 0,
      });
      const item2 = await TestBatchModel.find(testItems[1].getPrimaryId(), {
        batchDelay: 0,
      });

      expect(item1.getNumericConsumedCapacity("total")).toBeGreaterThan(0);
      expect(item2.getNumericConsumedCapacity("total")).toBeGreaterThan(0);
      expect(item1.name).toBe("Test Item 1");
      expect(item2.name).toBe("Test Item 2");
    });
  });

  test("should batch requests with delay>0", async () => {
    await runWithBatchContext(async () => {
      // Start multiple finds with a small delay
      const findPromises = [
        TestBatchModel.find(testItems[0].getPrimaryId(), {
          batchDelay: 10,
        }),
        TestBatchModel.find(testItems[1].getPrimaryId(), {
          batchDelay: 10,
        }),
        TestBatchModel.find(testItems[2].getPrimaryId(), {
          batchDelay: 10,
        }),
      ];

      const items = await Promise.all(findPromises);

      // Verify all items were loaded
      expect(items[0].name).toBe("Test Item 1");
      expect(items[1].name).toBe("Test Item 2");
      expect(items[2].name).toBe("Test Item 3");
    });
  });

  test("should use automatic cache to prevent reloading", async () => {
    await runWithBatchContext(async () => {
      // First load - should hit DynamoDB
      const item1 = await TestBatchModel.find(testItems[0].getPrimaryId(), {
        batchDelay: 0,
      });
      expect(item1.getNumericConsumedCapacity("total")).toBeGreaterThan(0);

      // Second load - should use automatic cache and return the same object
      const item2 = await TestBatchModel.find(testItems[0].getPrimaryId(), {
        batchDelay: 0,
      });

      // Should be the exact same cached object
      expect(item2).toBeDefined();
      expect(item2).toBe(item1); // Same object reference
      expect(item2.name).toBe("Test Item 1");
      expect(item2.getNumericConsumedCapacity("total")).toBeGreaterThan(0); // Retains original capacity
    });
  });

  test("should handle mixed batch delays correctly", async () => {
    await runWithBatchContext(async () => {
      const findPromises = [
        // These should be batched together
        TestBatchModel.find(testItems[0].getPrimaryId(), {
          batchDelay: 10,
        }),
        TestBatchModel.find(testItems[1].getPrimaryId(), {
          batchDelay: 10,
        }),
        // This should be immediate
        TestBatchModel.find(testItems[2].getPrimaryId(), {
          batchDelay: 0,
        }),
      ];

      const items = await Promise.all(findPromises);

      expect(items[0].name).toBe("Test Item 1");
      expect(items[1].name).toBe("Test Item 2");
      expect(items[2].name).toBe("Test Item 3");
    });
  });

  test("should handle errors for individual items", async () => {
    await runWithBatchContext(async () => {
      const findPromises = [
        TestBatchModel.find(testItems[0].getPrimaryId(), {
          batchDelay: 10,
        }),
        TestBatchModel.find("non-existent-id", { batchDelay: 10 }),
        TestBatchModel.find(testItems[2].getPrimaryId(), {
          batchDelay: 10,
        }),
      ];

      const results = await Promise.all(
        findPromises.map((p) => p.catch((e) => e)),
      );

      expect(results[0].name).toBe("Test Item 1");
      expect(results[1].exists()).toBe(false); // Non-existent items return null
      expect(results[2].name).toBe("Test Item 3");
    });
  });

  test("should bypass cache when bypassCache option is true", async () => {
    await runWithBatchContext(async () => {
      // First load - should hit DynamoDB and cache
      const item1 = await TestBatchModel.find(testItems[0].getPrimaryId(), {
        batchDelay: 0,
      });
      expect(item1.getNumericConsumedCapacity("total")).toBeGreaterThan(0);

      // Second load with bypassCache - should hit DynamoDB again
      const item2 = await TestBatchModel.find(testItems[0].getPrimaryId(), {
        batchDelay: 0,
        bypassCache: true,
      });

      expect(item2).toBeDefined();
      expect(item2.name).toBe("Test Item 1");
      expect(item2.getNumericConsumedCapacity("total")).toBeGreaterThan(0); // Should have consumed capacity
    });
  });

  test("should handle request timeouts", async () => {
    await runWithBatchContext(async () => {
      let batchRequests;
      let batchKey;
      let batch;

      // Create a request that will timeout and capture the batch info
      const promise = TestBatchModel.find(testItems[0].getPrimaryId(), {
        batchDelay: 50, // Small delay to ensure the batch is created
        bypassCache: true, // Use bypassCache to force DynamoDB request
      });

      // Wait a bit to ensure the batch is created
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Force cleanup of the batch using the test-scoped batch requests
      batchRequests = TestBatchModel._getBatchRequests();
      batchKey = `TestBatchModel-50`;
      batch = batchRequests.get(batchKey);

      // The batch should exist since we're in the same context
      expect(batch).toBeDefined();
      if (batch) {
        // Clear all timers before forcing the timeout
        if (batch.timer) clearTimeout(batch.timer);
        if (batch.timeoutTimer) clearTimeout(batch.timeoutTimer);

        batchRequests.delete(batchKey);
        batch.items.forEach((batchItem) => {
          batchItem.callbacks.forEach((cb) =>
            cb.reject(new Error("Batch request timed out")),
          );
        });
      }

      // Note: This timeout error might benefit from a specific TimeoutError exception in the future
      await expect(promise).rejects.toThrow("Batch request timed out");
    });
  });

  test("should throw error when not within runWithBatchContext", async () => {
    // This should throw an error since we're not in a batch context
    await expect(
      TestBatchModel.find(testItems[0].getPrimaryId(), { batchDelay: 0 }),
    ).rejects.toThrow(
      "Batch operations must be executed within runWithBatchContext()",
    );
  });
});
