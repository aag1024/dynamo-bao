const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig, IndexConfig } = require("../src/model");
const { StringField, RelatedField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

// Define test models
class Organization extends BaoModel {
  static modelPrefix = "org";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    organizationId: StringField({ required: true }),
    name: StringField({ required: true }),
    status: StringField({ required: true }),
  };

  static primaryKey = PrimaryKeyConfig("organizationId");

  static indexes = {
    statusIndex: IndexConfig("status", "organizationId", "gsi1"),
  };
}

class User extends BaoModel {
  static modelPrefix = "usr";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    userId: StringField({ required: true }),
    organizationId: RelatedField("Organization", { required: true }),
    name: StringField({ required: true }),
    email: StringField({ required: true }),
    role: StringField({ required: true }),
    status: StringField({ required: true }),
  };

  static primaryKey = PrimaryKeyConfig("userId");

  static indexes = {
    statusIndex: IndexConfig("status", "userId", "gsi1"),
  };
}

describe("AsyncLocalStorage Batch Context Tests", () => {
  let testId, testOrgs, testUsers;
  const NUM_ORGS = 2;
  const USERS_PER_ORG = 5;

  beforeEach(async () => {
    testId = ulid();
    const manager = initTestModelsWithTenant(testConfig, testId);

    // Register the test models
    manager.registerModel(Organization);
    manager.registerModel(User);

    await cleanupTestDataByIteration(testId, [Organization, User]);
    await verifyCleanup(testId, [Organization, User]);

    // Create test organizations
    testOrgs = await Promise.all(
      Array(NUM_ORGS)
        .fill()
        .map((_, i) =>
          Organization.create({
            organizationId: ulid(),
            name: `Test Org ${i}`,
            status: "active",
          }),
        ),
    );

    // Create test users for each org
    testUsers = [];
    for (const org of testOrgs) {
      const orgUsers = await Promise.all(
        Array(USERS_PER_ORG)
          .fill()
          .map((_, i) =>
            User.create({
              userId: ulid(),
              organizationId: org.organizationId,
              name: `Test User ${i}`,
              email: `test${Date.now()}-${i}@example.com`,
              role: "user",
              status: "active",
            }),
          ),
      );
      testUsers.push(...orgUsers);
    }
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [Organization, User]);
      await verifyCleanup(testId, [Organization, User]);
    }
  });

  test("should isolate batch contexts between different runWithBatchContext calls", async () => {
    const userSlice1 = testUsers.slice(0, 3);
    const userSlice2 = testUsers.slice(3, 6);

    let context1BatchCount = 0;
    let context2BatchCount = 0;

    // Track when batches are executed by monitoring the _getBatchRequests method
    const originalGetBatchRequests = User.prototype._getBatchRequests;
    const batchTracking = new Map();

    User.prototype._getBatchRequests = function () {
      const requests = originalGetBatchRequests.call(this);
      const contextId =
        requests === originalGetBatchRequests.call(this) ? "same" : "different";
      batchTracking.set(this, requests);
      return requests;
    };

    // Execute two separate contexts concurrently
    const context1Promise = runWithBatchContext(async () => {
      // All finds in this context should be batched together
      const results = await Promise.all([
        User.find(userSlice1[0].userId, { batchDelay: 50 }),
        User.find(userSlice1[1].userId, { batchDelay: 50 }),
        User.find(userSlice1[2].userId, { batchDelay: 50 }),
      ]);

      context1BatchCount = results.length;
      return results;
    });

    const context2Promise = runWithBatchContext(async () => {
      // All finds in this context should be batched together, but separate from context1
      const results = await Promise.all([
        User.find(userSlice2[0].userId, { batchDelay: 50 }),
        User.find(userSlice2[1].userId, { batchDelay: 50 }),
        User.find(userSlice2[2].userId, { batchDelay: 50 }),
      ]);

      context2BatchCount = results.length;
      return results;
    });

    const [results1, results2] = await Promise.all([
      context1Promise,
      context2Promise,
    ]);

    // Restore original method
    User.prototype._getBatchRequests = originalGetBatchRequests;

    // Verify both contexts completed successfully
    expect(results1.length).toBe(3);
    expect(results2.length).toBe(3);
    expect(context1BatchCount).toBe(3);
    expect(context2BatchCount).toBe(3);

    // Verify we got the correct users
    expect(results1.map((u) => u.userId).sort()).toEqual(
      userSlice1.map((u) => u.userId).sort(),
    );
    expect(results2.map((u) => u.userId).sort()).toEqual(
      userSlice2.map((u) => u.userId).sort(),
    );
  });

  test("should enable efficient batching within a single context", async () => {
    const userIds = testUsers.slice(0, 5).map((u) => u.userId);

    const result = await runWithBatchContext(async () => {
      const startTime = Date.now();

      // All these finds should be batched together
      const users = await Promise.all([
        User.find(userIds[0], { batchDelay: 20 }),
        User.find(userIds[1], { batchDelay: 20 }),
        User.find(userIds[2], { batchDelay: 20 }),
        User.find(userIds[3], { batchDelay: 20 }),
        User.find(userIds[4], { batchDelay: 20 }),
      ]);

      const duration = Date.now() - startTime;

      return { users, duration };
    });

    // Verify all users were loaded
    expect(result.users.length).toBe(5);
    result.users.forEach((user, index) => {
      expect(user.userId).toBe(userIds[index]);
    });

    // Calculate total consumed capacity
    const totalCapacity = result.users.reduce((sum, user) => {
      return sum + user.getNumericConsumedCapacity("read", true);
    }, 0);

    // With efficient batching, capacity per user should be low
    expect(totalCapacity / result.users.length).toBeLessThan(1.0);
  });

  test("should handle loader context within batch context", async () => {
    const userIds = testUsers.slice(0, 3).map((u) => u.userId);

    const result = await runWithBatchContext(async () => {
      const loaderContext = {};

      // First load - should hit DynamoDB
      const firstLoad = await Promise.all([
        User.find(userIds[0], { batchDelay: 10, loaderContext }),
        User.find(userIds[1], { batchDelay: 10, loaderContext }),
        User.find(userIds[2], { batchDelay: 10, loaderContext }),
      ]);

      const firstLoadCapacity = firstLoad.reduce((sum, user) => {
        return sum + user.getNumericConsumedCapacity("read", true);
      }, 0);

      // Second load - should use loader context
      const secondLoad = await Promise.all([
        User.find(userIds[0], { batchDelay: 10, loaderContext }),
        User.find(userIds[1], { batchDelay: 10, loaderContext }),
        User.find(userIds[2], { batchDelay: 10, loaderContext }),
      ]);

      const secondLoadCapacity = secondLoad.reduce((sum, user) => {
        return sum + user.getNumericConsumedCapacity("read", true);
      }, 0);

      return {
        firstLoad,
        secondLoad,
        firstLoadCapacity,
        secondLoadCapacity,
        loaderContext,
      };
    });

    // Verify loader context worked
    expect(Object.keys(result.loaderContext).length).toBe(3);

    // Second load should have much lower capacity (cached)
    expect(result.secondLoadCapacity).toBeLessThan(
      result.firstLoadCapacity * 0.1,
    );

    // Verify same users returned
    expect(result.firstLoad.length).toBe(3);
    expect(result.secondLoad.length).toBe(3);
    result.firstLoad.forEach((user, index) => {
      expect(user.userId).toBe(result.secondLoad[index].userId);
    });
  });

  test("should handle duplicate requests within same batch context", async () => {
    const userId = testUsers[0].userId;

    const result = await runWithBatchContext(async () => {
      // Request the same user multiple times simultaneously
      const duplicatePromises = Array(8)
        .fill()
        .map(() => User.find(userId, { batchDelay: 30 }));

      const users = await Promise.all(duplicatePromises);

      const totalCapacity = users.reduce((sum, user) => {
        return sum + user.getNumericConsumedCapacity("read", true);
      }, 0);

      return { users, totalCapacity };
    });

    // All requests should return the same user
    expect(result.users.length).toBe(8);
    result.users.forEach((user) => {
      expect(user.userId).toBe(userId);
    });

    // Despite 8 requests, should only consume capacity for one (due to deduplication)
    expect(result.totalCapacity).toBeLessThan(2.0);
  });

  test("should work with related data loading", async () => {
    const result = await runWithBatchContext(async () => {
      const loaderContext = {};

      // Find users and load their related organization data
      const users = await Promise.all([
        User.find(testUsers[0].userId, { batchDelay: 20, loaderContext }),
        User.find(testUsers[1].userId, { batchDelay: 20, loaderContext }),
        User.find(testUsers[2].userId, { batchDelay: 20, loaderContext }),
      ]);

      // Load related organization data (should also be batched)
      await Promise.all(
        users.map((user) =>
          user.loadRelatedData(["organizationId"], loaderContext),
        ),
      );

      return { users, loaderContext };
    });

    // Verify users and their related data
    expect(result.users.length).toBe(3);
    result.users.forEach((user) => {
      const org = user.getRelated("organizationId");
      expect(org).toBeDefined();
      expect(org.organizationId).toBe(user.organizationId);
    });

    // Verify loader context contains both users and organizations
    const contextKeys = Object.keys(result.loaderContext);
    expect(contextKeys.length).toBeGreaterThan(3); // Should have users + orgs
  });

  test("should prevent cross-context interference", async () => {
    const sharedUserId = testUsers[0].userId;
    const context1Data = [];
    const context2Data = [];

    // Start two contexts that might interfere if not properly isolated
    const context1Promise = runWithBatchContext(async () => {
      // Add some delay to ensure contexts overlap
      await new Promise((resolve) => setTimeout(resolve, 10));

      const user = await User.find(sharedUserId, { batchDelay: 50 });
      context1Data.push(`context1-${user.userId}`);

      // Add another delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      return user;
    });

    const context2Promise = runWithBatchContext(async () => {
      // Add some delay to ensure contexts overlap
      await new Promise((resolve) => setTimeout(resolve, 15));

      const user = await User.find(sharedUserId, { batchDelay: 50 });
      context2Data.push(`context2-${user.userId}`);

      return user;
    });

    const [user1, user2] = await Promise.all([
      context1Promise,
      context2Promise,
    ]);

    // Both should get the same user data
    expect(user1.userId).toBe(sharedUserId);
    expect(user2.userId).toBe(sharedUserId);

    // But contexts should not have interfered with each other
    expect(context1Data.length).toBe(1);
    expect(context2Data.length).toBe(1);
    expect(context1Data[0]).toBe(`context1-${sharedUserId}`);
    expect(context2Data[0]).toBe(`context2-${sharedUserId}`);
  });

  test("should fall back gracefully when not using runWithBatchContext", async () => {
    // Capture console warnings
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
      // This should work but may show warnings about missing context
      const user = await User.find(testUsers[0].userId, { batchDelay: 0 }); // Use delay=0 to avoid batching

      expect(user).toBeDefined();
      expect(user.userId).toBe(testUsers[0].userId);

      // Should still work even without proper context
    } finally {
      console.warn = originalWarn;
    }
  });

  test("should simulate Cloudflare Workers fetch handler pattern", async () => {
    // Simulate multiple concurrent "requests" like in Cloudflare Workers
    const simulateRequest = (requestId, userIds) => {
      return runWithBatchContext(async () => {
        // Each "request" processes multiple users with batching
        const users = await Promise.all(
          userIds.map((id) => User.find(id, { batchDelay: 25 })),
        );

        // Simulate additional processing within the request
        const loaderContext = {};
        await Promise.all(
          users.map((user) =>
            user.loadRelatedData(["organizationId"], loaderContext),
          ),
        );

        return {
          requestId,
          users: users.map((u) => ({ id: u.userId, name: u.name })),
          totalCapacity: users.reduce(
            (sum, u) => sum + u.getNumericConsumedCapacity("read", true),
            0,
          ),
          cacheSize: Object.keys(loaderContext).length,
        };
      });
    };

    // Simulate 3 concurrent requests
    const request1Promise = simulateRequest(
      "req-1",
      testUsers.slice(0, 2).map((u) => u.userId),
    );
    const request2Promise = simulateRequest(
      "req-2",
      testUsers.slice(2, 4).map((u) => u.userId),
    );
    const request3Promise = simulateRequest(
      "req-3",
      testUsers.slice(4, 6).map((u) => u.userId),
    );

    const [result1, result2, result3] = await Promise.all([
      request1Promise,
      request2Promise,
      request3Promise,
    ]);

    // Verify each request completed independently
    expect(result1.requestId).toBe("req-1");
    expect(result2.requestId).toBe("req-2");
    expect(result3.requestId).toBe("req-3");

    // Each request should have processed its users
    expect(result1.users.length).toBe(2);
    expect(result2.users.length).toBe(2);
    expect(result3.users.length).toBe(2);

    // Each request should have used batching efficiently (low capacity per user)
    // Allow for some overhead since we're also loading related data
    expect(result1.totalCapacity / result1.users.length).toBeLessThan(2.0);
    expect(result2.totalCapacity / result2.users.length).toBeLessThan(2.0);
    expect(result3.totalCapacity / result3.users.length).toBeLessThan(2.0);

    // Each request should have built its own cache (at least the users)
    expect(result1.cacheSize).toBeGreaterThan(0);
    expect(result2.cacheSize).toBeGreaterThan(0);
    expect(result3.cacheSize).toBeGreaterThan(0);
  });
});
