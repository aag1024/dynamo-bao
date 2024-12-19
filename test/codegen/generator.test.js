const dynamoBao = require("dynamo-bao");
const testConfig = require("../config");
const { cleanupTestData, verifyCleanup } = require("../utils/test-utils");
const { ulid } = require("ulid");
const { Post } = require("./generated/post");
const { User } = require("./generated/user");
const { Comment } = require("./generated/comment");

let testId;

describe("Generated Models", () => {
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
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  describe("User Model", () => {
    test("should create a user", async () => {
      const user = await User.create({
        name: "Test User",
        email: "test@example.com",
      });

      expect(user.name).toBe("Test User");
      expect(user.email).toBe("test@example.com");
      expect(user.userId).toBeTruthy();
      expect(user.createdAt).toBeTruthy();
      expect(user.modifiedAt).toBeTruthy();
    });

    test("should enforce unique email constraint", async () => {
      await User.create({
        name: "Test User 1",
        email: "same@example.com",
      });

      await expect(async () => {
        await User.create({
          name: "Test User 2",
          email: "same@example.com",
        });
      }).rejects.toThrow();
    });

    test("should query related posts", async () => {
      const user = await User.create({
        name: "Test User",
        email: "test@example.com",
      });

      await Post.create({
        userId: user.userId,
        title: "Post 1",
        content: "Content 1",
      });

      await Post.create({
        userId: user.userId,
        title: "Post 2",
        content: "Content 2",
      });

      const posts = await user.queryPosts();
      expect(posts.items.length).toBe(2);
      expect(posts.items[0].title).toBe("Post 1");
      expect(posts.items[1].title).toBe("Post 2");
    });
  });

  describe("Post Model", () => {
    let user;

    beforeEach(async () => {
      user = await User.create({
        name: "Test User",
        email: "test@example.com",
      });
    });

    test("should create a post", async () => {
      const post = await Post.create({
        title: "Test Post",
        content: "Test Content",
        userId: user.userId,
      });

      expect(post.title).toBe("Test Post");
      expect(post.content).toBe("Test Content");
      expect(post.userId).toBe(user.userId);
      expect(post.postId).toBeTruthy();
      expect(post.createdAt).toBeTruthy();
    });

    test("should query all posts", async () => {
      await Post.create({
        title: "Post 1",
        content: "Content 1",
        userId: user.userId,
      });

      await Post.create({
        title: "Post 2",
        content: "Content 2",
        userId: user.userId,
      });

      const posts = await Post.queryAllPosts();
      expect(posts.items.length).toBe(2);
    });

    test("should query related comments", async () => {
      const post = await Post.create({
        title: "Test Post",
        content: "Test Content",
        userId: user.userId,
      });

      await Comment.create({
        postId: post.postId,
        authorId: user.userId,
        text: "Comment 1",
      });

      await Comment.create({
        postId: post.postId,
        authorId: user.userId,
        text: "Comment 2",
      });

      const comments = await post.queryComments();
      expect(comments.items.length).toBe(2);
      expect(comments.items[0].text).toBe("Comment 1");
      expect(comments.items[1].text).toBe("Comment 2");
    });
  });

  describe("Comment Model", () => {
    let user, post;

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
    });

    test("should create a comment", async () => {
      const comment = await Comment.create({
        postId: post.postId,
        authorId: user.userId,
        text: "Test Comment",
        numLikes: 0,
      });

      expect(comment.postId).toBe(post.postId);
      expect(comment.authorId).toBe(user.userId);
      expect(comment.text).toBe("Test Comment");
      expect(comment.commentId).toBeTruthy();
      expect(comment.createdAt).toBeTruthy();
    });

    test("should find comments by post", async () => {
      await Comment.create({
        postId: post.postId,
        authorId: user.userId,
        text: "Comment 1",
      });

      await Comment.create({
        postId: post.postId,
        authorId: user.userId,
        text: "Comment 2",
      });

      const comments = await Comment.queryByIndex(
        "commentsForPost",
        post.postId,
      );
      expect(comments.items.length).toBe(2);
      expect(comments.items[0].text).toBe("Comment 1");
      expect(comments.items[1].text).toBe("Comment 2");
    });
  });
});
