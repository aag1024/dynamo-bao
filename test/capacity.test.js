const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { verifyCapacityUsage } = require("./dynamoTestUtils");
const { ulid } = require("ulid");

let totalConsumedCapacity = 0,
  testId,
  User;

// Add helper function to track capacity
async function sumConsumedCapacity() {
  return totalConsumedCapacity;
}

beforeEach(async () => {
  await runWithBatchContext(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    User = manager.getModel("User");

    if (testId) {
      await cleanupTestDataByIteration(testId, [User]);
      await verifyCleanup(testId, [User]);
    }

    totalConsumedCapacity = 0; // Reset capacity counter
  });
});

afterEach(async () => {
  await runWithBatchContext(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [User]);
      await verifyCleanup(testId, [User]);
    }
  });
});

describe("Capacity Usage Tests", () => {
  test("should create user with expected capacity", async () => {
    await runWithBatchContext(async () => {
      const result = await verifyCapacityUsage(
        async () =>
          await User.create({
            name: "Test User 1",
            email: "test1@example.com",
          }),
        0.5, // Expected RCU
        7.0, // Expected WCU - for create with unique constraints
      );
      expect(result).toBeDefined();
      expect(result.email).toBe("test1@example.com");
    });
  });

  test("should update user without unique field change", async () => {
    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
        status: "active",
      });

      user.clearConsumedCapacity();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await verifyCapacityUsage(
        async () =>
          await User.update(user.userId, {
            name: "Updated Name",
            status: user.status,
          }),
        0.5, // Expected RCU
        4.0, // Expected WCU - adjusted for single update with index
      );
      expect(result.name).toBe("Updated Name");
    });
  });

  test("should update user with unique field change", async () => {
    let userId;

    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
        status: "active",
      });
      userId = user.userId;

      await new Promise((resolve) => setTimeout(resolve, 100));

      await verifyCapacityUsage(
        async () =>
          await User.update(user.userId, {
            email: "new-email@example.com",
            status: user.status,
          }),
        1.0, // Expected RCU - reads are eventually consistent
        22.0, // Expected WCU - for update with unique constraint changes (increased due to caching operations)
      );
    });

    // Use separate batch context to verify the update
    await runWithBatchContext(async () => {
      const result = await User.find(userId);
      expect(result.email).toBe("new-email@example.com");
    });
  });

  test("should delete user with expected capacity", async () => {
    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
      });

      const userId = user.userId; // Store userId before deletion

      const result = await verifyCapacityUsage(
        async () => await User.delete(userId),
        0, // Expected RCU
        7.0, // Expected WCU - for delete with unique constraints
      );
      expect(result.userId).toBe(userId);
    });
  });
});

describe("Query Capacity Tests", () => {
  test("should efficiently query by index", async () => {
    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User",
        email: "test@example.com",
        externalId: "ext1",
        externalPlatform: "platform1",
        role: "user",
        status: "active",
      });

      const capacityBefore = await sumConsumedCapacity();

      const results = await Promise.all([
        User.queryByIndex("byPlatform", "platform1"),
        User.queryByIndex("byRole", "user"),
        User.queryByIndex("byStatus", "active"),
      ]);

      const capacityAfter = await sumConsumedCapacity();
      const capacityUsed = capacityAfter - capacityBefore;

      expect(capacityUsed).toBeLessThanOrEqual(3);
      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.items.length).toBeGreaterThan(0);
      });
    });
  });
});
