const dynamoBao = require("../src");
const {
  TenantContext,
  runWithBatchContext,
  getBatchContextCapacity,
} = dynamoBao;
const testConfig = require("./config");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

let testId, User, Post, Comment;

beforeEach(async () => {
  await runWithBatchContext(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    User = manager.getModel("User");
    Post = manager.getModel("Post");
    Comment = manager.getModel("Comment");

    if (testId) {
      await cleanupTestDataByIteration(testId, [Comment, Post, User]);
      await verifyCleanup(testId, [Comment, Post, User]);
    }
  });
});

afterEach(async () => {
  await runWithBatchContext(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [Comment, Post, User]);
      await verifyCleanup(testId, [Comment, Post, User]);
    }
  });
});

describe("getBatchContextCapacity", () => {
  describe("basic functionality", () => {
    test("should return { read: 0, write: 0 } when called outside batch context", () => {
      const capacity = getBatchContextCapacity();
      expect(capacity).toEqual({ read: 0, write: 0 });
    });

    test("should return { read: 0, write: 0 } at the start of a batch context", async () => {
      await runWithBatchContext(async () => {
        const capacity = getBatchContextCapacity();
        expect(capacity).toEqual({ read: 0, write: 0 });
      });
    });

    test("should return a copy of the accumulator (not the original)", async () => {
      await runWithBatchContext(async () => {
        const capacity1 = getBatchContextCapacity();
        const capacity2 = getBatchContextCapacity();
        expect(capacity1).not.toBe(capacity2);
        expect(capacity1).toEqual(capacity2);
      });
    });
  });

  describe("tracking write operations", () => {
    test("should track capacity from create operation", async () => {
      await runWithBatchContext(async () => {
        const capacityBefore = getBatchContextCapacity();
        expect(capacityBefore.write).toBe(0);

        await User.create({
          name: "Test User",
          email: `test-${ulid()}@example.com`,
        });

        const capacityAfter = getBatchContextCapacity();
        expect(capacityAfter.write).toBeGreaterThan(0);
      });
    });

    test("should track capacity from update operation", async () => {
      await runWithBatchContext(async () => {
        const user = await User.create({
          name: "Test User",
          email: `test-${ulid()}@example.com`,
        });

        // Get capacity after create
        const capacityAfterCreate = getBatchContextCapacity();

        // Update the user
        await User.update(user.userId, { name: "Updated Name" });

        const capacityAfterUpdate = getBatchContextCapacity();
        expect(capacityAfterUpdate.write).toBeGreaterThan(
          capacityAfterCreate.write,
        );
      });
    });

    test("should track capacity from delete operation", async () => {
      await runWithBatchContext(async () => {
        const user = await User.create({
          name: "Test User",
          email: `test-${ulid()}@example.com`,
        });

        const capacityAfterCreate = getBatchContextCapacity();

        await User.delete(user.userId);

        const capacityAfterDelete = getBatchContextCapacity();
        expect(capacityAfterDelete.write).toBeGreaterThan(
          capacityAfterCreate.write,
        );
      });
    });
  });

  describe("tracking read operations", () => {
    test("should track capacity from find operation", async () => {
      let userId;
      await runWithBatchContext(async () => {
        const user = await User.create({
          name: "Test User",
          email: `test-${ulid()}@example.com`,
        });
        userId = user.userId;
      });

      // Use a new batch context to test find
      await runWithBatchContext(async () => {
        const capacityBefore = getBatchContextCapacity();
        expect(capacityBefore.read).toBe(0);

        await User.find(userId);

        const capacityAfter = getBatchContextCapacity();
        expect(capacityAfter.read).toBeGreaterThan(0);
      });
    });

    test("should track capacity from find with batchDelay=0", async () => {
      let userId;
      await runWithBatchContext(async () => {
        const user = await User.create({
          name: "Test User",
          email: `test-${ulid()}@example.com`,
        });
        userId = user.userId;
      });

      await runWithBatchContext(async () => {
        const capacityBefore = getBatchContextCapacity();

        await User.find(userId, { batchDelay: 0 });

        const capacityAfter = getBatchContextCapacity();
        expect(capacityAfter.read).toBeGreaterThan(capacityBefore.read);
      });
    });

    test("should track capacity from batched find operations", async () => {
      let userIds = [];
      await runWithBatchContext(async () => {
        for (let i = 0; i < 3; i++) {
          const user = await User.create({
            name: `Test User ${i}`,
            email: `test-${ulid()}@example.com`,
          });
          userIds.push(user.userId);
        }
      });

      await runWithBatchContext(async () => {
        const capacityBefore = getBatchContextCapacity();

        // Trigger batched find by calling find concurrently
        await Promise.all(userIds.map((id) => User.find(id)));

        const capacityAfter = getBatchContextCapacity();
        expect(capacityAfter.read).toBeGreaterThan(capacityBefore.read);
      });
    });

    test("should track capacity from batchFind operation", async () => {
      let userIds = [];
      await runWithBatchContext(async () => {
        for (let i = 0; i < 3; i++) {
          const user = await User.create({
            name: `Test User ${i}`,
            email: `test-${ulid()}@example.com`,
          });
          userIds.push(user.userId);
        }
      });

      await runWithBatchContext(async () => {
        const capacityBefore = getBatchContextCapacity();

        await User.batchFind(userIds);

        const capacityAfter = getBatchContextCapacity();
        expect(capacityAfter.read).toBeGreaterThan(capacityBefore.read);
      });
    });

    test("should track capacity from query operations", async () => {
      await runWithBatchContext(async () => {
        // Create a user to query
        await User.create({
          name: "Test User",
          email: `test-${ulid()}@example.com`,
          status: "active",
        });

        const capacityBeforeQuery = getBatchContextCapacity();

        // Perform a query
        await User.queryByIndex("byStatus", "active");

        const capacityAfterQuery = getBatchContextCapacity();
        expect(capacityAfterQuery.read).toBeGreaterThan(
          capacityBeforeQuery.read,
        );
      });
    });

    test("should track capacity from count-only query", async () => {
      await runWithBatchContext(async () => {
        await User.create({
          name: "Test User",
          email: `test-${ulid()}@example.com`,
          status: "active",
        });

        const capacityBeforeQuery = getBatchContextCapacity();

        await User.queryByIndex("byStatus", "active", null, { countOnly: true });

        const capacityAfterQuery = getBatchContextCapacity();
        expect(capacityAfterQuery.read).toBeGreaterThan(
          capacityBeforeQuery.read,
        );
      });
    });
  });

  describe("accumulating across multiple operations", () => {
    test("should accumulate capacity across multiple operations", async () => {
      await runWithBatchContext(async () => {
        const user1 = await User.create({
          name: "User 1",
          email: `test1-${ulid()}@example.com`,
        });

        const capacityAfterCreate1 = getBatchContextCapacity();

        const user2 = await User.create({
          name: "User 2",
          email: `test2-${ulid()}@example.com`,
        });

        const capacityAfterCreate2 = getBatchContextCapacity();
        expect(capacityAfterCreate2.write).toBeGreaterThan(
          capacityAfterCreate1.write,
        );
      });
    });

    test("should track both read and write capacity in same context", async () => {
      await runWithBatchContext(async () => {
        // Create a user (write)
        const user = await User.create({
          name: "Test User",
          email: `test-${ulid()}@example.com`,
          status: "active",
        });

        const capacityAfterCreate = getBatchContextCapacity();
        expect(capacityAfterCreate.write).toBeGreaterThan(0);

        // Query users (read)
        await User.queryByIndex("byStatus", "active");

        const capacityAfterQuery = getBatchContextCapacity();
        expect(capacityAfterQuery.read).toBeGreaterThan(0);
        expect(capacityAfterQuery.write).toEqual(capacityAfterCreate.write);
      });
    });

    test("should track capacity across multiple models", async () => {
      await runWithBatchContext(async () => {
        const user = await User.create({
          name: "Test User",
          email: `test-${ulid()}@example.com`,
        });

        const capacityAfterUser = getBatchContextCapacity();

        const post = await Post.create({
          postId: ulid(),
          userId: user.userId,
          title: "Test Post",
          content: "Test content",
        });

        const capacityAfterPost = getBatchContextCapacity();
        expect(capacityAfterPost.write).toBeGreaterThan(
          capacityAfterUser.write,
        );
      });
    });
  });

  describe("context isolation", () => {
    test("should isolate capacity between different batch contexts", async () => {
      let capacityFromFirstContext;
      let capacityFromSecondContext;

      await runWithBatchContext(async () => {
        await User.create({
          name: "User 1",
          email: `test1-${ulid()}@example.com`,
        });
        capacityFromFirstContext = getBatchContextCapacity();
      });

      await runWithBatchContext(async () => {
        // Should start fresh
        const capacityAtStart = getBatchContextCapacity();
        expect(capacityAtStart).toEqual({ read: 0, write: 0 });

        await User.create({
          name: "User 2",
          email: `test2-${ulid()}@example.com`,
        });
        capacityFromSecondContext = getBatchContextCapacity();
      });

      // Both contexts should have similar capacity for similar operations
      // (but they are independent)
      expect(capacityFromFirstContext.write).toBeGreaterThan(0);
      expect(capacityFromSecondContext.write).toBeGreaterThan(0);
    });

    test("should return zero capacity outside batch context after context ends", async () => {
      await runWithBatchContext(async () => {
        await User.create({
          name: "Test User",
          email: `test-${ulid()}@example.com`,
        });

        const capacityInside = getBatchContextCapacity();
        expect(capacityInside.write).toBeGreaterThan(0);
      });

      // Outside the context, should return zeros
      const capacityOutside = getBatchContextCapacity();
      expect(capacityOutside).toEqual({ read: 0, write: 0 });
    });
  });

  describe("edge cases", () => {
    test("should handle ObjectNotFound without throwing", async () => {
      await runWithBatchContext(async () => {
        const result = await User.find("non-existent-id");
        expect(result.exists()).toBe(false);

        // Should still track the read capacity
        const capacity = getBatchContextCapacity();
        expect(capacity.read).toBeGreaterThan(0);
      });
    });

    test("should handle ObjectNotFound in batched find", async () => {
      await runWithBatchContext(async () => {
        // Use default batchDelay to trigger batched path
        const result = await User.find("non-existent-batched-id");
        expect(result.exists()).toBe(false);

        // Should still track the read capacity
        const capacity = getBatchContextCapacity();
        expect(capacity.read).toBeGreaterThan(0);
      });
    });

    test("should handle empty batchFind", async () => {
      await runWithBatchContext(async () => {
        const result = await User.batchFind([]);
        expect(Object.keys(result.items)).toHaveLength(0);

        // No capacity should be consumed for empty batch
        const capacity = getBatchContextCapacity();
        expect(capacity.read).toBe(0);
      });
    });

    test("should handle query with no results", async () => {
      await runWithBatchContext(async () => {
        const result = await User.queryByIndex(
          "byStatus",
          "non-existent-status",
        );
        expect(result.items).toHaveLength(0);

        // Should still track read capacity
        const capacity = getBatchContextCapacity();
        expect(capacity.read).toBeGreaterThan(0);
      });
    });

    test("should handle batchFind with mix of existing and non-existing ids", async () => {
      let existingUserId;
      await runWithBatchContext(async () => {
        const user = await User.create({
          name: "Existing User",
          email: `existing-${ulid()}@example.com`,
        });
        existingUserId = user.userId;
      });

      await runWithBatchContext(async () => {
        const result = await User.batchFind([
          existingUserId,
          "non-existent-id-1",
          "non-existent-id-2",
        ]);

        // Should have one item
        expect(Object.keys(result.items)).toHaveLength(1);
        expect(result.items[existingUserId]).toBeDefined();

        // Should track capacity
        const capacity = getBatchContextCapacity();
        expect(capacity.read).toBeGreaterThan(0);
      });
    });

    test("should handle cached items not consuming additional capacity", async () => {
      let userId;
      await runWithBatchContext(async () => {
        const user = await User.create({
          name: "Cached User",
          email: `cached-${ulid()}@example.com`,
        });
        userId = user.userId;
      });

      await runWithBatchContext(async () => {
        // First find - should consume capacity
        await User.find(userId);
        const capacityAfterFirst = getBatchContextCapacity();

        // Second find - should be cached, no additional capacity
        await User.find(userId);
        const capacityAfterSecond = getBatchContextCapacity();

        // Capacity should be the same (cached hit)
        expect(capacityAfterSecond.read).toBe(capacityAfterFirst.read);
      });
    });

    test("should handle bypassCache option consuming capacity each time", async () => {
      let userId;
      await runWithBatchContext(async () => {
        const user = await User.create({
          name: "Bypass User",
          email: `bypass-${ulid()}@example.com`,
        });
        userId = user.userId;
      });

      await runWithBatchContext(async () => {
        // First find with bypassCache
        await User.find(userId, { bypassCache: true, batchDelay: 0 });
        const capacityAfterFirst = getBatchContextCapacity();

        // Second find with bypassCache - should consume additional capacity
        await User.find(userId, { bypassCache: true, batchDelay: 0 });
        const capacityAfterSecond = getBatchContextCapacity();

        // Capacity should increase (not cached)
        expect(capacityAfterSecond.read).toBeGreaterThan(capacityAfterFirst.read);
      });
    });
  });

  describe("use case: request metering", () => {
    test("should support typical request metering workflow", async () => {
      let totalCapacity;

      await runWithBatchContext(async () => {
        // Simulate a typical API request workflow
        // 1. Create a user
        const user = await User.create({
          name: "API User",
          email: `api-${ulid()}@example.com`,
          status: "active",
        });

        // 2. Create a post for the user
        const post = await Post.create({
          postId: ulid(),
          userId: user.userId,
          title: "My First Post",
          content: "Hello, world!",
        });

        // 3. Query user's posts
        await Post.queryByIndex("postsForUser", user.userId);

        // 4. Find the user again
        await User.find(user.userId);

        // At the end of the request, get total capacity
        totalCapacity = getBatchContextCapacity();
      });

      // Verify we got meaningful capacity data
      expect(totalCapacity.read).toBeGreaterThan(0);
      expect(totalCapacity.write).toBeGreaterThan(0);

      // Log for demonstration (in real use case, this would go to a metering system)
      console.log(`Request consumed: ${totalCapacity.read} RCUs, ${totalCapacity.write} WCUs`);
    });
  });
});

describe("getBatchContextCapacity export", () => {
  test("should be exported from main module", () => {
    expect(getBatchContextCapacity).toBeDefined();
    expect(typeof getBatchContextCapacity).toBe("function");
  });

  test("should be accessible via require", () => {
    const { getBatchContextCapacity: imported } = require("../src");
    expect(imported).toBeDefined();
    expect(typeof imported).toBe("function");
  });
});
