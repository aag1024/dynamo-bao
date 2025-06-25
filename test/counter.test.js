const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, CounterField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { ValidationError } = require("../src/exceptions");

let testId;

class TestCounter extends BaoModel {
  static modelPrefix = "tc";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    counterId: StringField({ required: true }),
    name: StringField(),
    count: CounterField({ defaultValue: 0 }),
    otherCount: CounterField({ defaultValue: 10 }),
  };

  static primaryKey = PrimaryKeyConfig("counterId");
}

describe("Counter Field Tests", () => {
  let testCounter;

  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();

      const manager = initTestModelsWithTenant(testConfig, testId);

      // Then register the TestCounter model
      manager.registerModel(TestCounter);

      if (testId) {
        await cleanupTestDataByIteration(testId, [TestCounter]);
        await verifyCleanup(testId, [TestCounter]);
      }

      // Create a new counter for each test
      testCounter = await TestCounter.create({
        counterId: `test-counter-${Date.now()}`, // Make ID unique for each test
        name: "Test Counter",
        count: 0,
        otherCount: 10,
      });
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [TestCounter]);
        await verifyCleanup(testId, [TestCounter]);
      }
    });
  });

  test("should initialize with default value", async () => {
    await runWithBatchContext(async () => {
      const counter = await TestCounter.create({
        counterId: `test-counter-${Date.now()}-2`,
        name: "Test Counter 2",
      });

      // Fetch the counter to verify the values
      const fetchedCounter = await TestCounter.find(counter.counterId);

      expect(fetchedCounter.count).toBe(0);
      expect(fetchedCounter.otherCount).toBe(10);
    });
  });

  test("should increment counter atomically", async () => {
    await runWithBatchContext(async () => {
      const result = await TestCounter.update(testCounter.counterId, {
        count: "+1",
      });

      expect(result.count).toBe(1);
    });
  });

  test("should decrement counter atomically", async () => {
    await runWithBatchContext(async () => {
      const result = await TestCounter.update(testCounter.counterId, {
        otherCount: "-5",
      });

      expect(result.otherCount).toBe(5);
    });
  });

  test("should handle multiple counter operations in one update", async () => {
    await runWithBatchContext(async () => {
      const result = await TestCounter.update(testCounter.counterId, {
        count: "+5",
        otherCount: "-2",
      });

      expect(result.count).toBe(5);
      expect(result.otherCount).toBe(8);
    });
  });

  test("should allow setting absolute values", async () => {
    await runWithBatchContext(async () => {
      const result = await TestCounter.update(testCounter.counterId, {
        count: 42,
      });

      expect(result.count).toBe(42);
    });
  });

  test("should handle mixed counter and regular field updates", async () => {
    await runWithBatchContext(async () => {
      const result = await TestCounter.update(testCounter.counterId, {
        count: "+1",
        name: "Updated Counter",
      });

      expect(result.count).toBe(1);
      expect(result.name).toBe("Updated Counter");
    });
  });

  test("should maintain counter value through multiple updates", async () => {
    await runWithBatchContext(async () => {
      // First increment
      await TestCounter.update(testCounter.counterId, { count: "+5" });
    });

    await runWithBatchContext(async () => {
      // Second increment
      await TestCounter.update(testCounter.counterId, { count: "+3" });
    });

    await runWithBatchContext(async () => {
      // Verify final value
      const finalCounter = await TestCounter.find(testCounter.counterId);
      expect(finalCounter.count).toBe(8);
    });
  });

  test("should handle concurrent increments correctly", async () => {
    let counterId;

    await runWithBatchContext(async () => {
      counterId = `test-counter-${Date.now()}`;

      // Create a fresh counter
      await TestCounter.create({
        counterId: counterId,
        count: 0,
      });
    });

    // Run concurrent updates in separate contexts to test real concurrency
    const updates = [];
    for (let i = 0; i < 5; i++) {
      updates.push(
        runWithBatchContext(async () => {
          return await TestCounter.update(counterId, { count: "+1" });
        }),
      );
    }

    await Promise.all(updates);

    await runWithBatchContext(async () => {
      const finalCounter = await TestCounter.find(counterId);
      expect(finalCounter.count).toBe(5);
    });
  }, 15000);

  test("should validate counter values", async () => {
    await runWithBatchContext(async () => {
      // Should reject non-integer values
      await expect(
        TestCounter.create({
          counterId: "test-counter-3",
          count: 3.14,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
