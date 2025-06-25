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

// Define test model
class User extends BaoModel {
  static modelPrefix = "usr";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    userId: StringField({ required: true }),
    name: StringField({ required: true }),
    status: StringField({ required: true }),
  };

  static primaryKey = PrimaryKeyConfig("userId");
}

describe("Nested Batch Context Tests", () => {
  let testId, testUsers;

  beforeEach(async () => {
    testId = ulid();
    const manager = initTestModelsWithTenant(testConfig, testId);
    manager.registerModel(User);

    await cleanupTestDataByIteration(testId, [User]);
    await verifyCleanup(testId, [User]);

    // Create test users
    testUsers = await Promise.all(
      Array(5)
        .fill()
        .map((_, i) =>
          User.create({
            userId: ulid(),
            name: `Test User ${i}`,
            status: "active",
          }),
        ),
    );
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [User]);
      await verifyCleanup(testId, [User]);
    }
  });

  test("should create NEW isolation context when nested", async () => {
    const outerBatchMap = [];
    const innerBatchMap = [];

    const result = await runWithBatchContext(async () => {
      // Store reference to outer context batch map
      outerBatchMap.push(User._getBatchRequests());

      // Load some users in outer context
      const outerUser = await User.find(testUsers[0].userId, {
        batchDelay: 10,
      });

      const innerResult = await runWithBatchContext(async () => {
        // Store reference to inner context batch map
        innerBatchMap.push(User._getBatchRequests());

        // Load some users in inner context
        const innerUser = await User.find(testUsers[1].userId, {
          batchDelay: 10,
        });

        return {
          innerUser,
          innerBatchMapSize: innerBatchMap[0].size,
          innerContextId: "inner",
        };
      });

      return {
        outerUser,
        innerResult,
        outerBatchMapSize: outerBatchMap[0].size,
        outerContextId: "outer",
      };
    });

    // Verify we got different batch maps (new isolation)
    expect(outerBatchMap[0]).not.toBe(innerBatchMap[0]);

    // Both contexts should work independently
    expect(result.outerUser.userId).toBe(testUsers[0].userId);
    expect(result.innerResult.innerUser.userId).toBe(testUsers[1].userId);
  });

  test("should demonstrate context switching behavior with AsyncLocalStorage", async () => {
    const contextTracker = [];

    const result = await runWithBatchContext(async () => {
      // Get outer context
      const outerContext = User._getBatchRequests();
      contextTracker.push({ level: "outer-start", map: outerContext });

      const innerResult = await runWithBatchContext(async () => {
        // Get inner context
        const innerContext = User._getBatchRequests();
        contextTracker.push({ level: "inner", map: innerContext });

        // Load a user in inner context
        const user = await User.find(testUsers[0].userId, { batchDelay: 20 });

        return { user, innerContext };
      });

      // Back in outer context - should be the same as outer-start
      const outerContextAfter = User._getBatchRequests();
      contextTracker.push({ level: "outer-after", map: outerContextAfter });

      return { innerResult, outerContext, outerContextAfter };
    });

    // Verify context behavior
    expect(contextTracker.length).toBe(3);

    // Outer context before and after should be the same
    expect(contextTracker[0].map).toBe(contextTracker[2].map);

    // Inner context should be different
    expect(contextTracker[1].map).not.toBe(contextTracker[0].map);
    expect(contextTracker[1].map).not.toBe(contextTracker[2].map);
  });

  test("should handle batching independently in nested contexts", async () => {
    const result = await runWithBatchContext(async () => {
      // Start some batch requests in outer context
      const outerPromise1 = User.find(testUsers[0].userId, { batchDelay: 50 });
      const outerPromise2 = User.find(testUsers[1].userId, { batchDelay: 50 });

      const innerResult = await runWithBatchContext(async () => {
        // Start batch requests in inner context (independent batching)
        const innerPromise1 = User.find(testUsers[2].userId, {
          batchDelay: 30,
        });
        const innerPromise2 = User.find(testUsers[3].userId, {
          batchDelay: 30,
        });

        const [innerUser1, innerUser2] = await Promise.all([
          innerPromise1,
          innerPromise2,
        ]);

        return {
          innerUsers: [innerUser1, innerUser2],
          innerCapacity:
            innerUser1.getNumericConsumedCapacity("read", true) +
            innerUser2.getNumericConsumedCapacity("read", true),
        };
      });

      // Complete outer context batches
      const [outerUser1, outerUser2] = await Promise.all([
        outerPromise1,
        outerPromise2,
      ]);

      return {
        outerUsers: [outerUser1, outerUser2],
        outerCapacity:
          outerUser1.getNumericConsumedCapacity("read", true) +
          outerUser2.getNumericConsumedCapacity("read", true),
        innerResult,
      };
    });

    // Verify both contexts completed successfully
    expect(result.outerUsers.length).toBe(2);
    expect(result.innerResult.innerUsers.length).toBe(2);

    // Verify correct users were loaded
    expect(result.outerUsers[0].userId).toBe(testUsers[0].userId);
    expect(result.outerUsers[1].userId).toBe(testUsers[1].userId);
    expect(result.innerResult.innerUsers[0].userId).toBe(testUsers[2].userId);
    expect(result.innerResult.innerUsers[1].userId).toBe(testUsers[3].userId);

    // Both should show efficient batching
    expect(result.outerCapacity / 2).toBeLessThan(1.0); // Batched in outer
    expect(result.innerResult.innerCapacity / 2).toBeLessThan(1.0); // Batched in inner
  });

  test("should demonstrate that nested context completely shadows outer context", async () => {
    let outerBatchRequests, innerBatchRequests;

    await runWithBatchContext(async () => {
      // Add something to outer context batch
      const outerUser = User.find(testUsers[0].userId, { batchDelay: 100 }); // Long delay
      outerBatchRequests = User._getBatchRequests();

      expect(outerBatchRequests.size).toBe(1); // Should have 1 batch request

      await runWithBatchContext(async () => {
        innerBatchRequests = User._getBatchRequests();

        // Inner context should start fresh - no batches from outer
        expect(innerBatchRequests.size).toBe(0);
        expect(innerBatchRequests).not.toBe(outerBatchRequests);

        // Add something to inner context
        const innerUser = User.find(testUsers[1].userId, { batchDelay: 20 });
        expect(innerBatchRequests.size).toBe(1); // Now has 1 batch request

        await innerUser; // Complete the inner batch
      });

      // Back in outer - should still have the original batch
      const outerAfter = User._getBatchRequests();
      expect(outerAfter).toBe(outerBatchRequests); // Same reference
      expect(outerAfter.size).toBe(1); // Still has the pending batch

      await outerUser; // Complete the outer batch
    });
  });
});
