const { initModels, runWithBatchContext } = require("../src/index");
const testConfig = require("./config");
const { cleanupTestDataByIteration } = require("./utils/test-utils");
const { TenantContext } = require("../src/tenant-context");
const { ulid } = require("ulid");

// Import models directly (simulating Cloudflare Workers environment)
const { User } = require("./models/user");
const { Post } = require("./models/post");
const { Comment } = require("./models/comment");
const { Tag } = require("./models/tag");
const { TaggedPost } = require("./models/tagged-post");
const { CommentLike } = require("./models/commentLike");

describe("Cloudflare Workers manifest pattern", () => {
  let testId;

  beforeEach(() => {
    testId = ulid();
    TenantContext.setCurrentTenant(testId);
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      const modelClasses = [User, Post, Comment, Tag, TaggedPost, CommentLike];
      await runWithBatchContext(async () => {
        await cleanupTestDataByIteration(testId, modelClasses);
      });
    }
  });

  test("should initialize models using direct imports (Cloudflare Workers pattern)", () => {
    // This simulates how Cloudflare Workers would use the library
    // with direct model imports instead of filesystem scanning
    const models = initModels({
      models: {
        User,
        Post,
        Comment,
        Tag,
        TaggedPost,
        CommentLike,
      },
      ...testConfig,
      tenancy: { enabled: true },
    });

    expect(models).toBeDefined();
    expect(models.models.User).toBe(User);
    expect(models.models.Post).toBe(Post);
    expect(models.models.Comment).toBe(Comment);
    expect(models.models.Tag).toBe(Tag);
    expect(models.models.TaggedPost).toBe(TaggedPost);
    expect(models.models.CommentLike).toBe(CommentLike);

    // Verify models are properly registered
    expect(models.getModels()).toContain(User);
    expect(models.getModels()).toContain(Post);
    expect(models.getModels()).toContain(Comment);
    expect(models.getModels()).toContain(Tag);
    expect(models.getModels()).toContain(TaggedPost);
    expect(models.getModels()).toContain(CommentLike);
  });

  test("should work with models initialized via direct imports", async () => {
    await runWithBatchContext(async () => {
      // Initialize using direct imports
      const models = initModels({
        models: { User, Post, Comment },
        ...testConfig,
        tenancy: { enabled: true },
      });

      const {
        User: UserModel,
        Post: PostModel,
        Comment: CommentModel,
      } = models.models;

      // Test basic CRUD operations
      const user = await UserModel.create({
        name: "John Doe",
        email: "john@example.com",
      });
      expect(user.name).toBe("John Doe");
      expect(user.email).toBe("john@example.com");

      const post = await PostModel.create({
        userId: user.userId,
        title: "Test Post",
        content: "This is a test post",
      });
      expect(post.title).toBe("Test Post");
      expect(post.userId).toBe(user.userId);

      const comment = await CommentModel.create({
        postId: post.postId,
        authorId: user.userId,
        text: "Great post!",
      });
      expect(comment.text).toBe("Great post!");
      expect(comment.postId).toBe(post.postId);
      expect(comment.authorId).toBe(user.userId);

      // Test queries work
      const foundUser = await UserModel.find(user.userId);
      expect(foundUser.name).toBe("John Doe");

      const foundPost = await PostModel.find(post.postId);
      expect(foundPost.title).toBe("Test Post");
    });
  });

  test("should handle partial model imports", () => {
    // Test with only a subset of models (common in Workers with tree-shaking)
    const models = initModels({
      models: { User, Post }, // Only importing User and Post
      ...testConfig,
      tenancy: { enabled: true },
    });

    expect(models.models.User).toBe(User);
    expect(models.models.Post).toBe(Post);
    expect(models.models.Comment).toBeUndefined();
    expect(models.models.Tag).toBeUndefined();

    // Should only contain the imported models
    expect(models.getModels()).toHaveLength(2);
    expect(models.getModels()).toContain(User);
    expect(models.getModels()).toContain(Post);
  });

  test("should simulate manifest file usage pattern", () => {
    // Simulate how a generated manifest would be used
    const generatedModels = {
      User,
      Post,
      Comment,
      Tag,
      TaggedPost,
      CommentLike,
    };

    const models = initModels({
      models: generatedModels, // This simulates importing from .bao/models.js
      ...testConfig,
      tenancy: { enabled: true },
    });

    expect(models).toBeDefined();
    expect(Object.keys(models.models)).toHaveLength(6);
    expect(models.models.User).toBe(User);
    expect(models.models.Post).toBe(Post);
    expect(models.models.Comment).toBe(Comment);
    expect(models.models.Tag).toBe(Tag);
    expect(models.models.TaggedPost).toBe(TaggedPost);
    expect(models.models.CommentLike).toBe(CommentLike);
  });

  test("should work with both filesystem and direct import patterns", () => {
    // Use a fresh tenant to avoid conflicts
    const freshTestId = ulid();
    TenantContext.setCurrentTenant(freshTestId);

    // Verify that the traditional filesystem approach still works
    const filesystemModels = initModels({
      ...testConfig,
      tenancy: { enabled: true },
    });

    // And the direct import approach works with a different tenant
    const directImportTestId = ulid();
    TenantContext.setCurrentTenant(directImportTestId);

    const directImportModels = initModels({
      models: { User, Post, Comment },
      ...testConfig,
      tenancy: { enabled: true },
    });

    // Both should have access to their respective models
    expect(filesystemModels.models.User).toBeDefined();
    expect(directImportModels.models.User).toBe(User);

    expect(filesystemModels.models.Post).toBeDefined();
    expect(directImportModels.models.Post).toBe(Post);

    expect(filesystemModels.models.Comment).toBeDefined();
    expect(directImportModels.models.Comment).toBe(Comment);

    // Main point: Direct import approach should only have specified models
    expect(directImportModels.models.Tag).toBeUndefined();
    expect(directImportModels.models.TaggedPost).toBeUndefined();
    expect(directImportModels.models.CommentLike).toBeUndefined();

    // Both should have core functionality
    expect(typeof filesystemModels.models.User.create).toBe("function");
    expect(typeof directImportModels.models.User.create).toBe("function");
    expect(typeof filesystemModels.models.Post.find).toBe("function");
    expect(typeof directImportModels.models.Post.find).toBe("function");
  });
});
