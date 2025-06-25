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
    externalId: StringField({ required: true }),
    externalPlatform: StringField({ required: true }),
    role: StringField({ required: true }),
    status: StringField({ required: true }),
  };

  static primaryKey = PrimaryKeyConfig("userId");

  static indexes = {
    statusIndex: IndexConfig("status", "userId", "gsi1"),
  };
}

class Post extends BaoModel {
  static modelPrefix = "pst";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    postId: StringField({ required: true }),
    userId: RelatedField("User", { required: true }),
    title: StringField({ required: true }),
    content: StringField({ required: true }),
    status: StringField({ defaultValue: "active" }),
  };

  static primaryKey = PrimaryKeyConfig("postId");

  static indexes = {
    statusIndex: IndexConfig("status", "postId", "gsi1"),
  };
}

describe("Batch Loading and Related Data", () => {
  let testId, testOrgs, testUsers, testPosts;
  const NUM_ORGS = 3;
  const USERS_PER_ORG = 10;
  const POSTS_PER_USER = 5;

  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();
      const manager = initTestModelsWithTenant(testConfig, testId);

      // Register the test models
      manager.registerModel(Organization);
      manager.registerModel(User);
      manager.registerModel(Post);

      await cleanupTestDataByIteration(testId, [Organization, User, Post]);
      await verifyCleanup(testId, [Organization, User, Post]);

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
                externalId: `ext${Date.now()}-${i}`,
                externalPlatform: "platform1",
                role: "user",
                status: "active",
              }),
            ),
        );
        testUsers.push(...orgUsers);
      }

      // Create test posts for each user
      testPosts = [];
      for (const user of testUsers) {
        const userPosts = await Promise.all(
          Array(POSTS_PER_USER)
            .fill()
            .map((_, i) =>
              Post.create({
                postId: ulid(),
                userId: user.userId,
                title: `Post ${i} by ${user.name}`,
                content: `Content ${i}`,
                status: "active",
              }),
            ),
        );
        testPosts.push(...userPosts);
      }
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [Organization, User, Post]);
        await verifyCleanup(testId, [Organization, User, Post]);
      }
    });
  });

  test("should batch load related data efficiently during queries", async () => {
    await runWithBatchContext(async () => {
      const startTime = Date.now();

      // Initialize an empty array to hold all posts
      let allPosts = [];
      let lastEvaluatedKey = null;

      // Keep querying until we get all posts
      do {
        const { items: posts, lastEvaluatedKey: lek } = await Post.queryByIndex(
          "statusIndex", // indexName
          "active", // pkValue
          null, // skCondition
          {
            // options
            loadRelated: true,
            relatedFields: ["userId"],
            startKey: lastEvaluatedKey,
            limit: 100,
          },
        );

        allPosts = [...allPosts, ...posts];
        lastEvaluatedKey = lek;
      } while (lastEvaluatedKey);

      const duration = Date.now() - startTime;

      // Verify we got all posts
      expect(allPosts.length).toBe(NUM_ORGS * USERS_PER_ORG * POSTS_PER_USER);

      // Verify each post has its related user loaded
      for (const post of allPosts) {
        const user = post.getRelated("userId");
        expect(user).toBeDefined();
        expect(user.userId).toBe(post.userId);
      }

      // Calculate consumed capacity
      const totalCapacity = allPosts.reduce((sum, post) => {
        return sum + post.getNumericConsumedCapacity("read", true);
      }, 0);

      // Performance should be reasonable
      expect(duration).toBeLessThan(10000); // 10 seconds
    });
  });

  test("should not reload objects already in context", async () => {
    await runWithBatchContext(async () => {
      // Pre-load some users
      const preloadedUsers = await Promise.all(
        testUsers.slice(0, 5).map((user) => User.find(user.userId)),
      );

      // Now query posts and load related data
      const posts = testPosts.slice(0, 10);
      await Promise.all(
        posts.map(async (post) => {
          await post.loadRelatedData(["userId"]);
        }),
      );

      // Verify that we got the same instances for preloaded users
      posts.forEach((post) => {
        const relatedUser = post.getRelated("userId");
        const preloadedUser = preloadedUsers.find(
          (user) => user.userId === post.userId,
        );

        if (preloadedUser) {
          expect(relatedUser).toBe(preloadedUser); // Same object reference
        }
      });
    });
  });

  test("should batch requests within batchDelay window", async () => {
    await runWithBatchContext(async () => {
      const startTime = Date.now();

      // Simulate concurrent requests that should be batched
      const promises = testPosts.slice(0, 10).map((post, index) => {
        return new Promise((resolve) => {
          setTimeout(async () => {
            await post.loadRelatedData(["userId"]);
            resolve();
          }, index * 5); // Stagger by 5ms
        });
      });

      await Promise.all(promises);

      const duration = Date.now() - startTime;

      // Should complete quickly due to batching
      expect(duration).toBeLessThan(2000); // 2 seconds
    });
  });

  test("should handle duplicate requests within same batch", async () => {
    await runWithBatchContext(async () => {
      const post = testPosts[0];
      const userId = post.userId;

      // Make multiple concurrent requests for the same user
      const promises = Array(5)
        .fill()
        .map(() => User.find(userId));

      const users = await Promise.all(promises);

      // All should return the same object reference
      users.forEach((user) => {
        expect(user).toBe(users[0]);
        expect(user.userId).toBe(userId);
      });
    });
  });

  test("should handle mixed batch and individual requests", async () => {
    await runWithBatchContext(async () => {
      const posts = testPosts.slice(0, 5);

      // Mix of batched and individual requests
      const results = await Promise.all([
        // Batch request
        Promise.all(posts.map((post) => post.loadRelatedData(["userId"]))),
        // Individual requests
        User.find(testUsers[0].userId),
        Organization.find(testOrgs[0].organizationId),
      ]);

      // Verify all requests completed successfully
      expect(results).toHaveLength(3);
      posts.forEach((post) => {
        expect(post.getRelated("userId")).toBeDefined();
      });
    });
  });

  test("should properly clean up batch context", async () => {
    let contextSize;

    await runWithBatchContext(async () => {
      // Load some data
      await Promise.all(
        testUsers.slice(0, 3).map((user) => User.find(user.userId)),
      );

      // The context should have some entries now but we can't directly access it
      // We'll verify this indirectly by checking that objects are cached
      const user = await User.find(testUsers[0].userId);
      expect(user).toBeDefined();
    });

    // After the context, a new context should be fresh
    await runWithBatchContext(async () => {
      // This should work without any reference to the previous context
      const user = await User.find(testUsers[0].userId, { bypassCache: true });
      expect(user).toBeDefined();
      expect(user.userId).toBe(testUsers[0].userId);
    });
  });
});
