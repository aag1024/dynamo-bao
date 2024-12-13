const dynamoBao = require('../src');
const testConfig = require('./config');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');
const { verifyCapacityUsage } = require('./dynamoTestUtils');

let testUser, testPost, testComment, testId;

describe('Capacity Tracking', () => {
  beforeEach(async () => {
    testId = ulid();
  
    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId
    });

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    User = manager.getModel('User');
    Post = manager.getModel('Post');
    Comment = manager.getModel('Comment');

    // Create test data
    testUser = await User.create({
      name: 'Test User',
      email: `test${Date.now()}@example.com`,
      externalId: `ext${Date.now()}`,
      externalPlatform: 'platform1',
      role: 'user',
      status: 'active'
    });

    testPost = await Post.create({
      userId: testUser.userId,
      title: 'Test Post',
      content: 'Test Content'
    });

    testComment = await Comment.create({
      postId: testPost.postId,
      authorId: testUser.userId,
      text: 'Test Comment'
    });

    testUser.clearConsumedCapacity();
    testPost.clearConsumedCapacity();
    testComment.clearConsumedCapacity();
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  describe('Single Item Operations', () => {
    test('should track capacity for finding single item', async () => {
      const result = await verifyCapacityUsage(
        async () => await Comment.find(testComment.getPrimaryId()),
        0.5,  // Expected RCU
        0     // Expected WCU
      );
      expect(result).toBeDefined();
      expect(result.text).toBe('Test Comment');
    });

    test('should track capacity when loading single related item', async () => {
      const comment = await Comment.find(testComment.getPrimaryId());
      const result = await verifyCapacityUsage(
        async () => await comment.loadRelatedData(['authorId']),
        1.0,  // Expected RCU (1 for original + 1 for related)
        0     // Expected WCU
      );
      expect(result).toBeDefined();
    });

    test('should track capacity when loading multiple related items', async () => {
      const comment = await Comment.find(testComment.getPrimaryId());
      const result = await verifyCapacityUsage(
        async () => await comment.loadRelatedData(['authorId', 'postId']),
        1.5,  // Expected RCU (1 original + 2 related)
        0     // Expected WCU
      );
      expect(result).toBeDefined();
    });
  });

  describe('Query Operations', () => {
    test('should track capacity for query operations', async () => {
      const result = await verifyCapacityUsage(
        async () => await Comment.queryByIndex('commentsForPost', testPost._getPkValue()),
        1.0,  // Expected RCU
        0     // Expected WCU
      );
      expect(result.items.length).toBeGreaterThan(0);
    });

    test('should track capacity when loading related data for query results', async () => {
      const result = await verifyCapacityUsage(
        async () => await Comment.queryByIndex(
          'commentsForPost',
          testPost._getPkValue(),
          null,
          {
            loadRelated: true,
            relatedFields: ['authorId']
          }
        ),
        2.0,  // Expected RCU (1 for query + 1 for related)
        0     // Expected WCU
      );
      expect(result.items.length).toBeGreaterThan(0);
    });
  });

  describe('Update Operations', () => {
    test('should track capacity for update operations', async () => {
      const result = await verifyCapacityUsage(
        async () => await Comment.update(testComment.getPrimaryId(), {
          text: 'Updated Comment'
        }),
        0.5,  // Expected RCU
        1.0   // Expected WCU
      );
      expect(result.text).toBe('Updated Comment');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty related data gracefully', async () => {
      const comment = await Comment.find(testComment.getPrimaryId());
      // Try to load a non-existent related field
      await comment.loadRelatedData(['nonexistentField']);
      expect(comment.getNumericConsumedCapacity('read')).toBe(0.5);
    });

    test('should track capacity when loading related data returns null', async () => {
      // Create a comment with non-existent authorId
      const orphanComment = await Comment.create({
        postId: testPost.postId,
        authorId: 'nonexistent-user-id',
        text: 'Orphan Comment'
      });

      await orphanComment.loadRelatedData(['authorId']);
      
      expect(orphanComment.getNumericConsumedCapacity('write', true)).toBe(2.0);
      expect(orphanComment.getNumericConsumedCapacity('read', true)).toBe(0.5);
    });

    test('should accumulate capacity for repeated related data loads', async () => {
      const comment = await Comment.find(testComment.getPrimaryId());
      
      // Load related data multiple times
      await comment.loadRelatedData(['authorId']);
      const firstLoadCapacity = comment.getNumericConsumedCapacity('read', true);

      await comment.loadRelatedData(['postId']);
      const secondLoadCapacity = comment.getNumericConsumedCapacity('read', true);
      
      expect(secondLoadCapacity).toBeGreaterThan(firstLoadCapacity);

      expect(comment.getNumericConsumedCapacity("read", true)).toBe(1.5); // Initial + authorId + postId
    });
  });
}); 