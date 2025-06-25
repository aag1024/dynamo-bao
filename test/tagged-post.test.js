const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { defaultLogger: logger } = require("../src/utils/logger");

let testId;

describe("TaggedPost Queries", () => {
  let testUser, testPost1, testPost2, testTag1, testTag2;
  let User, Post, Tag, TaggedPost;

  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();

      const manager = initTestModelsWithTenant(testConfig, testId);

      User = manager.getModel("User");
      Post = manager.getModel("Post");
      Tag = manager.getModel("Tag");
      TaggedPost = manager.getModel("TaggedPost");

      await cleanupTestDataByIteration(testId, [User, Post, Tag, TaggedPost]);
      await verifyCleanup(testId, [User, Post, Tag, TaggedPost]);

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
      [testPost1, testPost2] = await Promise.all([
        Post.create({
          userId: testUser.userId,
          title: "Test Post 1",
          content: "Content 1",
        }),
        Post.create({
          userId: testUser.userId,
          title: "Test Post 2",
          content: "Content 2",
        }),
      ]);

      // Create test tags
      [testTag1, testTag2] = await Promise.all([
        Tag.create({ name: "Tag1" }),
        Tag.create({ name: "Tag2" }),
      ]);

      // Create tagged posts relationships
      await Promise.all([
        TaggedPost.create({
          tagId: testTag1.tagId,
          postId: testPost1.postId,
        }),
        TaggedPost.create({
          tagId: testTag1.tagId,
          postId: testPost2.postId,
        }),
        TaggedPost.create({
          tagId: testTag2.tagId,
          postId: testPost1.postId,
        }),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [User, Post, Tag, TaggedPost]);
        await verifyCleanup(testId, [User, Post, Tag, TaggedPost]);
      }
    });
  });

  test("should query posts for a tag using primary key", async () => {
    await runWithBatchContext(async () => {
      const tag = await Tag.find(testTag1.tagId);
      expect(tag.tagId).toBe(testTag1.tagId);

      const posts = await TaggedPost.getRelatedObjectsViaMap(
        "postsForTag",
        testTag1.tagId,
        "postId",
      );

      expect(posts.items).toHaveLength(2);
      expect(posts.items.map((p) => p.postId).sort()).toEqual(
        [testPost1.postId, testPost2.postId].sort(),
      );
    });
  });

  test("should query tags for a post using GSI", async () => {
    await runWithBatchContext(async () => {
      const post = await Post.find(testPost1.postId);

      const tags = await TaggedPost.getRelatedObjectsViaMap(
        "tagsForPost",
        post.postId,
        "tagId",
      );

      expect(tags.items).toHaveLength(2);
      expect(tags.items.map((t) => t.tagId).sort()).toEqual(
        [testTag1.tagId, testTag2.tagId].sort(),
      );
    });
  });

  test("should query recent posts for a tag", async () => {
    await runWithBatchContext(async () => {
      const tag = await Tag.find(testTag1.tagId);
      const recentTaggedPosts = await await TaggedPost.queryByIndex(
        "recentPostsForTag",
        tag.tagId,
      );

      expect(recentTaggedPosts.items).toHaveLength(2);
      expect(
        recentTaggedPosts.items[0].createdAt.getTime(),
      ).toBeLessThanOrEqual(recentTaggedPosts.items[1].createdAt.getTime());
    });
  });

  test("should handle pagination for posts by tag", async () => {
    await runWithBatchContext(async () => {
      const tag = await Tag.find(testTag1.tagId);
      const firstPage = await TaggedPost.getRelatedObjectsViaMap(
        "postsForTag",
        tag.tagId,
        "postId",
        null,
        1,
        "DESC",
      );

      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.lastEvaluatedKey).toBeDefined();

      const secondPage = await TaggedPost.getRelatedObjectsViaMap(
        "postsForTag",
        tag.tagId,
        "postId",
        null,
        2,
        "DESC",
        firstPage.lastEvaluatedKey,
      );

      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.lastEvaluatedKey).toBeUndefined();
      expect(firstPage.items[0].postId).not.toBe(secondPage.items[0].postId);
    });
  });

  test("should return empty results for tag with no posts", async () => {
    await runWithBatchContext(async () => {
      const emptyTag = await Tag.create({ name: "Empty Tag" });

      const posts = await TaggedPost.getRelatedObjectsViaMap(
        "postsForTag",
        emptyTag.tagId,
        "postId",
      );

      expect(posts.items).toHaveLength(0);
      expect(posts.lastEvaluatedKey).toBeUndefined();
    });
  });

  test("should return empty results for post with no tags", async () => {
    await runWithBatchContext(async () => {
      const untaggedPost = await Post.create({
        userId: testUser.userId,
        title: "Untagged Post",
        content: "No Tags",
      });

      const tags = await TaggedPost.getRelatedObjectsViaMap(
        "tagsForPost",
        untaggedPost.postId,
        "tagId",
      );

      expect(tags.items).toHaveLength(0);
      expect(tags.lastEvaluatedKey).toBeUndefined();
    });
  });
});
