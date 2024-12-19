const dynamoBao = require("dynamo-bao");
const testConfig = require("../config");
const { cleanupTestData, verifyCleanup } = require("../utils/test-utils");
const { ulid } = require("ulid");
const { Post } = require("./generated/post");
const { User } = require("./generated/user");
const { Comment } = require("./generated/comment");

let testId;

describe("Related Field Getters", () => {
  let user, post, comment;

  beforeEach(async () => {
    testId = ulid();

    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });

    // Register all models
    manager.registerModel(Post);
    manager.registerModel(User);
    manager.registerModel(Comment);

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }

    // Create test data
    user = await User.create({
      name: "Test User",
      email: "test@example.com",
    });

    post = await Post.create({
      title: "Test Post",
      content: "Test Content",
      userId: user.userId,
    });

    comment = await Comment.create({
      postId: post.postId,
      authorId: user.userId,
      text: "Test Comment",
    });
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  describe("Post Model", () => {
    test("should get related user via cgGetUser", async () => {
      const relatedUser = await post.getUser();
      expect(relatedUser).toBeTruthy();
      expect(relatedUser.userId).toBe(user.userId);
      expect(relatedUser.name).toBe("Test User");
      expect(relatedUser.email).toBe("test@example.com");
    });

    test("should cache related user after first fetch", async () => {
      // First fetch
      const relatedUser1 = await post.getUser();
      expect(relatedUser1.userId).toBe(user.userId);

      // Should return cached version
      const relatedUser2 = await post.getUser();
      expect(relatedUser2).toBe(relatedUser1);
    });

    test("should return null for non-existent relation", async () => {
      const postWithInvalidUser = await Post.create({
        title: "Invalid User Post",
        content: "Content",
        userId: "non-existent-id",
      });

      const relatedUser = await postWithInvalidUser.getUser();
      expect(relatedUser.exists()).toBe(false);
    });
  });

  describe("Comment Model", () => {
    test("should get related post via cgGetPost", async () => {
      const relatedPost = await comment.getPost();
      expect(relatedPost).toBeTruthy();
      expect(relatedPost.postId).toBe(post.postId);
      expect(relatedPost.title).toBe("Test Post");
      expect(relatedPost.content).toBe("Test Content");
    });

    test("should get related author via cgGetAuthor", async () => {
      const relatedAuthor = await comment.getAuthor();
      expect(relatedAuthor).toBeTruthy();
      expect(relatedAuthor.userId).toBe(user.userId);
      expect(relatedAuthor.name).toBe("Test User");
    });

    test("should handle multiple related fields independently", async () => {
      const relatedPost = await comment.getPost();
      const relatedAuthor = await comment.getAuthor();

      expect(relatedPost.postId).toBe(post.postId);
      expect(relatedAuthor.userId).toBe(user.userId);
    });

    test("should clear cache when relation is updated", async () => {
      // First fetch
      const originalAuthor = await comment.getAuthor();
      expect(originalAuthor.userId).toBe(user.userId);

      // Create new user
      const newUser = await User.create({
        name: "New User",
        email: "new@example.com",
      });

      // Update comment's author
      comment.authorId = newUser.userId;
      await comment.save();

      // Should fetch new author
      const newAuthor = await comment.getAuthor();
      expect(newAuthor.userId).toBe(newUser.userId);
      expect(newAuthor.name).toBe("New User");
    });
  });
});
