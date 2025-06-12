const dynamoBao = require("dynamo-bao");
const { TenantContext } = dynamoBao;
const testConfig = require("../config");
const { cleanupTestDataByIteration, verifyCleanup, initTestModelsWithTenant } = require("../utils/test-utils");
const { ulid } = require("ulid");
const { Tag } = require("./generated/tag");
const { TaggedPost } = require("./generated/tagged-post");
const { Post } = require("./generated/post");
const { User } = require("./generated/user");

let testId;

describe("Generated Tag Models", () => {
  beforeEach(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    // Register all models
    manager.registerModel(Tag);
    manager.registerModel(TaggedPost);
    manager.registerModel(Post);
    manager.registerModel(User);

});

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [Tag, TaggedPost, Post, User]);
      await verifyCleanup(testId, [Tag, TaggedPost, Post, User]);
    }
  });

  describe("Tag Model", () => {
    test("should create a tag", async () => {
      const tag = await Tag.create({
        name: "JavaScript",
      });

      expect(tag.name).toBe("JavaScript");
      expect(tag.tagId).toBeTruthy();
      expect(tag.createdAt).toBeTruthy();
    });

    test("should get related posts via cgGetPosts", async () => {
      const user = await User.create({
        name: "Test User",
        email: "test@example.com",
      });

      const tag = await Tag.create({
        name: "JavaScript",
      });

      const post1 = await Post.create({
        userId: user.userId,
        title: "Post 1",
        content: "Content 1",
      });

      const post2 = await Post.create({
        userId: user.userId,
        title: "Post 2",
        content: "Content 2",
      });

      // Tag both posts
      await TaggedPost.create({
        tagId: tag.tagId,
        postId: post1.postId,
      });

      await TaggedPost.create({
        tagId: tag.tagId,
        postId: post2.postId,
      });

      const posts = await tag.getPosts();
      expect(posts.items.length).toBe(2);
      expect(posts.items[0].postId).toBe(post1.postId);
      expect(posts.items[1].postId).toBe(post2.postId);
    });

    test("should get recent posts via cgGetRecentPosts", async () => {
      const user = await User.create({
        name: "Test User",
        email: "test@example.com",
      });

      const tag = await Tag.create({
        name: "JavaScript",
      });

      const post1 = await Post.create({
        userId: user.userId,
        title: "Post 1",
        content: "Content 1",
      });

      const post2 = await Post.create({
        userId: user.userId,
        title: "Post 2",
        content: "Content 2",
      });

      // Tag both posts
      await TaggedPost.create({
        tagId: tag.tagId,
        postId: post1.postId,
      });

      await TaggedPost.create({
        tagId: tag.tagId,
        postId: post2.postId,
      });

      const posts = await tag.getRecentPosts(null, 10, "DESC");
      expect(posts.items.length).toBe(2);
      // Should be in reverse chronological order due to DESC
      expect(posts.items[0].postId).toBe(post2.postId);
      expect(posts.items[1].postId).toBe(post1.postId);
    });
  });

  describe("TaggedPost Model", () => {
    let user, post, tag;

    beforeEach(async () => {
      user = await User.create({
        name: "Test User",
        email: "test@example.com",
      });

      post = await Post.create({
        title: "Test Post",
        content: "Test Content",
        userId: user.userId,
      });

      tag = await Tag.create({
        name: "JavaScript",
      });
    });

    test("should create a tagged post", async () => {
      const taggedPost = await TaggedPost.create({
        tagId: tag.tagId,
        postId: post.postId,
      });

      expect(taggedPost.tagId).toBe(tag.tagId);
      expect(taggedPost.postId).toBe(post.postId);
      expect(taggedPost.createdAt).toBeTruthy();
    });

    test("should find tags for a post", async () => {
      const tag2 = await Tag.create({
        name: "TypeScript",
      });

      await TaggedPost.create({
        tagId: tag.tagId,
        postId: post.postId,
      });

      await TaggedPost.create({
        tagId: tag2.tagId,
        postId: post.postId,
      });

      const tags = await TaggedPost.queryByIndex("tagsForPost", post.postId);
      expect(tags.items.length).toBe(2);
      expect(tags.items[0].tagId).toBe(tag.tagId);
      expect(tags.items[1].tagId).toBe(tag2.tagId);
    });
  });
});
