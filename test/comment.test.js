const dynamoBao = require("../src/index");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

let testUser, testPost, testId, User, Post, Comment;

describe("Comment Model", () => {
  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();

      const manager = initTestModelsWithTenant(testConfig, testId);

      User = manager.getModel("User");
      Post = manager.getModel("Post");
      Comment = manager.getModel("Comment");

      // Create a test user and post for each test
      testUser = await User.create({
        name: "Test User",
        email: `test${Date.now()}@example.com`,
        externalId: `ext${Date.now()}`,
        externalPlatform: "platform1",
        role: "user",
        status: "active",
      });

      testPost = await Post.create({
        userId: testUser.userId,
        title: "Test Post",
        content: "Test Content",
      });
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [User, Post, Comment]);
        await verifyCleanup(testId, [User, Post, Comment]);
      }
    });
  });

  describe("Basic CRUD Operations", () => {
    test("should create comment successfully", async () => {
      await runWithBatchContext(async () => {
        const comment = await Comment.create({
          postId: testPost.postId,
          authorId: testUser.userId,
          text: "Test Comment",
        });

        expect(comment.postId).toBe(testPost.postId);
        expect(comment.authorId).toBe(testUser.userId);
        expect(comment.text).toBe("Test Comment");
        expect(comment.createdAt).toBeInstanceOf(Date);
        expect(comment.numLikes).toBe(0);
        expect(comment.commentId).toBeDefined();
      });
    });

    test("should find comment by primary key", async () => {
      await runWithBatchContext(async () => {
        const comment = await Comment.create({
          postId: testPost.postId,
          authorId: testUser.userId,
          text: "Test Comment",
        });

        const foundComment = await Comment.find(comment.getPrimaryId());
        expect(foundComment.text).toBe("Test Comment");
        expect(foundComment.authorId).toBe(testUser.userId);
      });
    });

    test("should update comment", async () => {
      let commentId;

      await runWithBatchContext(async () => {
        const comment = await Comment.create({
          postId: testPost.postId,
          authorId: testUser.userId,
          text: "Test Comment",
        });
        commentId = comment.getPrimaryId();

        await Comment.update(commentId, {
          text: "Updated Comment",
          numLikes: 1,
        });
      });

      // Use separate batch context to verify the update
      await runWithBatchContext(async () => {
        const updatedComment = await Comment.find(commentId);
        expect(updatedComment.text).toBe("Updated Comment");
        expect(updatedComment.numLikes).toBe(1);
      });
    });

    test("should delete comment", async () => {
      await runWithBatchContext(async () => {
        const comment = await Comment.create({
          postId: testPost.postId,
          authorId: testUser.userId,
          text: "Test Comment",
        });

        await Comment.delete(comment.getPrimaryId());
      });
    });
  });

  describe("Related Data Loading", () => {
    test("should load related author", async () => {
      await runWithBatchContext(async () => {
        const comment = await Comment.create({
          postId: testPost.postId,
          authorId: testUser.userId,
          text: "Test Comment",
        });

        await comment.loadRelatedData(["authorId"]);
        const author = comment.getRelated("authorId");

        expect(author).toBeDefined();
        expect(author.userId).toBe(testUser.userId);
        expect(author.name).toBe("Test User");
      });
    });

    test("should load related post", async () => {
      await runWithBatchContext(async () => {
        const comment = await Comment.create({
          postId: testPost.postId,
          authorId: testUser.userId,
          text: "Test Comment",
        });

        await comment.loadRelatedData(["postId"]);
        const post = comment.getRelated("postId");

        expect(post).toBeDefined();
        expect(post.postId).toBe(testPost.postId);
        expect(post.title).toBe("Test Post");
      });
    });

    test("should load all related data", async () => {
      await runWithBatchContext(async () => {
        const comment = await Comment.create({
          postId: testPost.postId,
          authorId: testUser.userId,
          text: "Test Comment",
        });

        await comment.loadRelatedData();
        const author = comment.getRelated("authorId");
        const post = comment.getRelated("postId");

        expect(author).toBeDefined();
        expect(author.userId).toBe(testUser.userId);
        expect(post).toBeDefined();
        expect(post.postId).toBe(testPost.postId);
      });
    });
  });

  describe("Instance Methods", () => {
    test("should track changes correctly", async () => {
      await runWithBatchContext(async () => {
        const comment = await Comment.create({
          postId: testPost.postId,
          authorId: testUser.userId,
          text: "Test Comment",
        });

        expect(comment.hasChanges()).toBeFalsy();

        comment.text = "Updated Text";
        comment.numLikes = 1;

        expect(comment.hasChanges()).toBeTruthy();
        expect(comment._getChanges()).toEqual({
          text: "Updated Text",
          numLikes: 1,
        });
      });
    });

    test("should save changes", async () => {
      await runWithBatchContext(async () => {
        const comment = await Comment.create({
          postId: testPost.postId,
          authorId: testUser.userId,
          text: "Test Comment",
        });

        comment.text = "Updated Text";
        await comment.save();

        const updatedComment = await Comment.find(comment.getPrimaryId());
        expect(updatedComment.text).toBe("Updated Text");
      });
    });
  });

  describe("Comment Queries", () => {
    test("should query comments for a post", async () => {
      await runWithBatchContext(async () => {
        // Create multiple comments for the test post
        const comments = await Promise.all([
          Comment.create({
            postId: testPost.postId,
            authorId: testUser.userId,
            text: "First Comment",
          }),
          Comment.create({
            postId: testPost.postId,
            authorId: testUser.userId,
            text: "Second Comment",
          }),
        ]);

        // Query comments using the post instance
        const result = await Comment.queryByIndex(
          "commentsForPost",
          testPost._getPkValue(),
        );

        expect(result.items).toHaveLength(2);
        expect(result.items.map((c) => c.text).sort()).toEqual(
          ["First Comment", "Second Comment"].sort(),
        );
      });
    });

    test("should handle pagination when querying comments", async () => {
      await runWithBatchContext(async () => {
        // Create multiple comments
        await Promise.all([
          Comment.create({
            postId: testPost.postId,
            authorId: testUser.userId,
            text: "First Comment",
          }),
          Comment.create({
            postId: testPost.postId,
            authorId: testUser.userId,
            text: "Second Comment",
          }),
        ]);

        // Get first page
        const firstPage = await Comment.queryByIndex(
          "commentsForPost",
          testPost._getPkValue(),
          null,
          {
            limit: 1,
          },
        );
        expect(firstPage.items).toHaveLength(1);
        expect(firstPage.lastEvaluatedKey).toBeDefined();

        // Get second page
        const secondPage = await Comment.queryByIndex(
          "commentsForPost",
          testPost._getPkValue(),
          null,
          {
            limit: 2,
            startKey: firstPage.lastEvaluatedKey,
          },
        );
        expect(secondPage.items).toHaveLength(1);
        expect(secondPage.lastEvaluatedKey).toBeUndefined();

        // Verify different comments were returned
        expect(firstPage.items[0].text).not.toBe(secondPage.items[0].text);
      });
    });

    test("should return empty result for post with no comments", async () => {
      await runWithBatchContext(async () => {
        // Create a new post with no comments
        const emptyPost = await Post.create({
          userId: testUser.userId,
          title: "Empty Post",
          content: "No Comments",
        });

        const result = await Comment.queryByIndex(
          "commentsForPost",
          emptyPost._getPkValue(),
        );

        expect(result.items).toHaveLength(0);
        expect(result.lastEvaluatedKey).toBeUndefined();
      });
    });
  });
});
