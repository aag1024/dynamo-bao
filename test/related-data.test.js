const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

describe("Related Data Loading", () => {
  let testUser, testPosts, testId;
  let User, Post;

  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();

      const manager = initTestModelsWithTenant(testConfig, testId);

      User = manager.getModel("User");
      Post = manager.getModel("Post");

      await cleanupTestDataByIteration(testId, [User, Post]);
      await verifyCleanup(testId, [User, Post]);

      // Create test user
      testUser = await User.create({
        name: "Test User",
        email: `test${Date.now()}@example.com`,
        externalId: `ext${Date.now()}`,
        externalPlatform: "platform1",
        role: "user",
        status: "active",
      });

      // Create test posts
      testPosts = await Promise.all([
        Post.create({
          userId: testUser.userId,
          title: "Post 1",
          content: "Content 1",
        }),
        Post.create({
          userId: testUser.userId,
          title: "Post 2",
          content: "Content 2",
        }),
      ]);
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [User, Post]);
        await verifyCleanup(testId, [User, Post]);
      }
    });
  });

  test("should load related data independently for different instances", async () => {
    await runWithBatchContext(async () => {
      // Create two posts with different users
      const user2 = await User.create({
        name: "Second User",
        email: `test2${Date.now()}@example.com`,
        externalId: `ext2${Date.now()}`,
        externalPlatform: "platform1",
        role: "user",
        status: "active",
      });

      const post1 = await Post.create({
        userId: testUser.userId,
        title: "First Post",
        content: "Content 1",
      });

      const post2 = await Post.create({
        userId: user2.userId,
        title: "Second Post",
        content: "Content 2",
      });

      // Load related data for both posts
      await Promise.all([post1.loadRelatedData(), post2.loadRelatedData()]);

      // Verify each post has its correct user
      const related1 = post1.getRelated("userId");
      const related2 = post2.getRelated("userId");

      expect(related1.userId).toBe(testUser.userId);
      expect(related2.userId).toBe(user2.userId);
    });
  });

  test("should share cached data within the same batch context", async () => {
    await runWithBatchContext(async () => {
      const post1 = testPosts[0];
      const post2 = testPosts[1];

      // Load related data for first post
      await post1.loadRelatedData();
      const user1 = post1.getRelated("userId");

      // Modify the cached user data
      user1.name = "Modified Name";

      // Load related data for second post
      await post2.loadRelatedData();
      const user2 = post2.getRelated("userId");

      // Verify the second post's related user shows the modified name (shared cache)
      expect(user2.name).toBe("Modified Name");
      expect(user1).toBe(user2); // Should be the exact same object reference
    });
  });

  test("should maintain separate caches between nested batch contexts", async () => {
    await runWithBatchContext(async () => {
      // First, test basic caching within the same context
      const user1 = await User.find(testUser.userId);
      const user2 = await User.find(testUser.userId);

      // Should be the exact same cached object
      expect(user2).toBe(user1);
      expect(user1.name).toBe("Test User");
      expect(user2.name).toBe("Test User");

      // When we modify user1, user2 should reflect the changes (same object)
      user1.name = "Modified Name";
      expect(user2.name).toBe("Modified Name"); // Should be same object

      // Create nested batch context to test isolation
      await runWithBatchContext(async () => {
        // Load same user in inner context (should create separate cache)
        const innerUser = await User.find(testUser.userId);

        // Inner context should have original name from database (separate cache)
        expect(innerUser.name).toBe("Test User");
        expect(innerUser).not.toBe(user1); // Should be different object references
      });

      // Back in outer context - user1 should still have modification
      expect(user1.name).toBe("Modified Name");
    });
  });

  test("should clear related cache when field value changes", async () => {
    await runWithBatchContext(async () => {
      const post = testPosts[0];
      await post.loadRelatedData();

      const originalUser = post.getRelated("userId");
      expect(originalUser.userId).toBe(testUser.userId);

      // Create a new user and update the post
      const newUser = await User.create({
        name: "New User",
        email: `new${Date.now()}@example.com`,
        externalId: `new${Date.now()}`,
        externalPlatform: "platform1",
        role: "user",
        status: "active",
      });

      post.userId = newUser.userId;
      await post.loadRelatedData();

      const updatedUser = post.getRelated("userId");
      expect(updatedUser.userId).toBe(newUser.userId);
    });
  });

  test("should load only specified related fields", async () => {
    await runWithBatchContext(async () => {
      // Create a post with a user and add some tags
      const post = await Post.create({
        userId: testUser.userId,
        title: "Test Post",
        content: "Content",
      });

      // Load only the user relationship
      await post.loadRelatedData(["userId"]);

      // User should be loaded
      const relatedUser = post.getRelated("userId");
      expect(relatedUser).toBeDefined();
      expect(relatedUser.userId).toBe(testUser.userId);
    });
  });

  test("should load multiple specified fields", async () => {
    await runWithBatchContext(async () => {
      const post = await Post.create({
        userId: testUser.userId,
        title: "Test Post",
        content: "Content",
      });

      // Load user relationship
      await post.loadRelatedData(["userId"]);

      // User relationship should be loaded
      const relatedUser = post.getRelated("userId");
      expect(relatedUser).toBeDefined();
      expect(relatedUser.userId).toBe(testUser.userId);
    });
  });

  test("should load all fields when no fields specified", async () => {
    await runWithBatchContext(async () => {
      const post = await Post.create({
        userId: testUser.userId,
        title: "Test Post",
        content: "Content",
      });

      // Load all related data
      await post.loadRelatedData();

      // User relationship should be loaded
      const relatedUser = post.getRelated("userId");
      expect(relatedUser).toBeDefined();
      expect(relatedUser.userId).toBe(testUser.userId);
    });
  });

  test("should ignore invalid field names", async () => {
    await runWithBatchContext(async () => {
      const post = await Post.create({
        userId: testUser.userId,
        title: "Test Post",
        content: "Content",
      });

      // Should not throw error for invalid field
      await expect(
        post.loadRelatedData(["userId", "invalidField"]),
      ).resolves.toBeDefined();

      // Valid field should still be loaded
      const relatedUser = post.getRelated("userId");
      expect(relatedUser).toBeDefined();
      expect(relatedUser.userId).toBe(testUser.userId);
    });
  });
});
