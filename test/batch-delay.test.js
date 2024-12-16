const dynamoBao = require("../src");
const testConfig = require("./config");
const { BaseModel, PrimaryKeyConfig } = require("../src/model");
const { StringField } = require("../src/fields");
const { cleanupTestData, verifyCleanup } = require("./utils/test-utils");
const { ulid } = require("ulid");

let testId;

class TestBatchModel extends BaseModel {
  static modelPrefix = "tbm";

  static fields = {
    itemId: StringField({ required: true }),
    name: StringField({ required: true }),
    value: StringField(),
  };

  static primaryKey = PrimaryKeyConfig("itemId");
}

describe("Batch Delay Tests", () => {
  let testItems = [];
  let loaderContext = {};

  beforeEach(async () => {
    testId = ulid();
    loaderContext = {};

    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });

    manager.registerModel(TestBatchModel);

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }

    // Create test items
    testItems = await Promise.all([
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

  afterEach(async () => {
    // Clear batch requests for this test
    const testBatchRequests = TestBatchModel.getBatchRequests();
    if (testBatchRequests) {
      testBatchRequests.forEach((batch) => {
        // Clear all timers associated with the batch
        if (batch.timer) clearTimeout(batch.timer);
        if (batch.timeoutTimer) clearTimeout(batch.timeoutTimer);
      });
      testBatchRequests.clear();
    }

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test("should make individual requests with delay=0", async () => {
    const item1 = await TestBatchModel.find(testItems[0].getPrimaryId(), {
      batchDelay: 0,
      loaderContext,
    });
    const item2 = await TestBatchModel.find(testItems[1].getPrimaryId(), {
      batchDelay: 0,
      loaderContext,
    });

    expect(item1.getNumericConsumedCapacity("total")).toBeGreaterThan(0);
    expect(item2.getNumericConsumedCapacity("total")).toBeGreaterThan(0);
    expect(item1.name).toBe("Test Item 1");
    expect(item2.name).toBe("Test Item 2");
  });

  test("should batch requests with delay>0", async () => {
    // Start multiple finds with a small delay
    const findPromises = [
      TestBatchModel.find(testItems[0].getPrimaryId(), {
        batchDelay: 10,
        loaderContext,
      }),
      TestBatchModel.find(testItems[1].getPrimaryId(), {
        batchDelay: 10,
        loaderContext,
      }),
      TestBatchModel.find(testItems[2].getPrimaryId(), {
        batchDelay: 10,
        loaderContext,
      }),
    ];

    const items = await Promise.all(findPromises);

    // Verify all items were loaded
    expect(items[0].name).toBe("Test Item 1");
    expect(items[1].name).toBe("Test Item 2");
    expect(items[2].name).toBe("Test Item 3");

    // Verify items are in loader context
    expect(loaderContext[testItems[0].getPrimaryId()]).toBeDefined();
    expect(loaderContext[testItems[1].getPrimaryId()]).toBeDefined();
    expect(loaderContext[testItems[2].getPrimaryId()]).toBeDefined();
  });

  test("should use loader context to prevent reloading", async () => {
    // First load - should hit DynamoDB
    const item1 = await TestBatchModel.find(testItems[0].getPrimaryId(), {
      batchDelay: 0,
      loaderContext,
    });
    expect(item1.getNumericConsumedCapacity("total")).toBeGreaterThan(0);

    // Verify item is in loader context
    expect(loaderContext[testItems[0].getPrimaryId()]).toBeDefined();

    // Second load - should use loader context and not make a DynamoDB request
    const item2 = await TestBatchModel.find(testItems[0].getPrimaryId(), {
      batchDelay: 0,
      loaderContext,
    });

    // When loaded from context
    expect(item2).toBeDefined();
    expect(item2.name).toBe("Test Item 1");
    expect(item2.getNumericConsumedCapacity("total")).toBe(0);
  });

  test("should handle mixed batch delays correctly", async () => {
    const findPromises = [
      // These should be batched together
      TestBatchModel.find(testItems[0].getPrimaryId(), {
        batchDelay: 10,
        loaderContext,
      }),
      TestBatchModel.find(testItems[1].getPrimaryId(), {
        batchDelay: 10,
        loaderContext,
      }),
      // This should be immediate
      TestBatchModel.find(testItems[2].getPrimaryId(), {
        batchDelay: 0,
        loaderContext,
      }),
    ];

    const items = await Promise.all(findPromises);

    expect(items[0].name).toBe("Test Item 1");
    expect(items[1].name).toBe("Test Item 2");
    expect(items[2].name).toBe("Test Item 3");
  });

  test("should handle errors for individual items", async () => {
    const findPromises = [
      TestBatchModel.find(testItems[0].getPrimaryId(), {
        batchDelay: 10,
        loaderContext,
      }),
      TestBatchModel.find("non-existent-id", { batchDelay: 10, loaderContext }),
      TestBatchModel.find(testItems[2].getPrimaryId(), {
        batchDelay: 10,
        loaderContext,
      }),
    ];

    const results = await Promise.all(
      findPromises.map((p) => p.catch((e) => e)),
    );

    expect(results[0].name).toBe("Test Item 1");
    expect(results[1].exists()).toBe(false); // Non-existent items return null
    expect(results[2].name).toBe("Test Item 3");
  });

  test("should handle request timeouts", async () => {
    // Create a request that will timeout
    const promise = TestBatchModel.find(testItems[0].getPrimaryId(), {
      batchDelay: 50, // Small delay to ensure the batch is created
      loaderContext: {}, // Use new loader context to force DynamoDB request
    });

    // Wait a bit to ensure the batch is created
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Force cleanup of the batch using the test-scoped batch requests
    const batchRequests = TestBatchModel.getBatchRequests();
    const batchKey = `TestBatchModel-50`;
    const batch = batchRequests.get(batchKey);

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

    await expect(promise).rejects.toThrow("Batch request timed out");
  });
});
