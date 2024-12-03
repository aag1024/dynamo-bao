const dynamoBao = require('../src');
const testConfig = require('./config');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');

let testUser, testPost, testComment, testId;

describe('Capacity Tracking', () => {
  beforeEach(async () => {
    testId = ulid();
  
    const manager = dynamoBao.initModels({
      ...testConfig,
      tableName: process.env.TABLE_NAME,
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
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  describe('Single Item Operations', () => {
    test('should track capacity for finding single item', async () => {
      const comment = await Comment.find(testComment.getPrimaryId());
      expect(comment._response).toBeDefined();
      expect(comment._response.ConsumedCapacity).toBeDefined();
      expect(comment._response.ConsumedCapacity).toBeInstanceOf(Object);
      expect(comment._response.ConsumedCapacity.TableName).toBe(process.env.TABLE_NAME);
      expect(comment._response.ConsumedCapacity.CapacityUnits).toBeGreaterThan(0);
    });

    test('should track capacity when loading single related item', async () => {
      const comment = await Comment.find(testComment.getPrimaryId());
      await comment.loadRelatedData(['authorId']);
      
      expect(comment._response.ConsumedCapacity).toBeDefined();
      expect(Array.isArray(comment._response.ConsumedCapacity)).toBeTruthy();
      expect(comment._response.ConsumedCapacity.length).toBe(2); // Original get + related load
      
      // Verify both operations consumed capacity
      comment._response.ConsumedCapacity.forEach(capacity => {
        expect(capacity.TableName).toBe(process.env.TABLE_NAME);
        expect(capacity.CapacityUnits).toBeGreaterThan(0);
      });
    });

    test('should track capacity when loading multiple related items', async () => {
      const comment = await Comment.find(testComment.getPrimaryId());
      await comment.loadRelatedData(['authorId', 'postId']);
      
      expect(comment._response.ConsumedCapacity).toBeDefined();
      expect(Array.isArray(comment._response.ConsumedCapacity)).toBeTruthy();
      expect(comment._response.ConsumedCapacity.length).toBe(3); // Original get + 2 related loads
      
      const totalCapacity = comment._response.ConsumedCapacity.reduce(
        (sum, capacity) => sum + capacity.CapacityUnits, 
        0
      );
      expect(totalCapacity).toBeGreaterThan(1);
    });
  });

  describe('Query Operations', () => {
    test('should track capacity for query operations', async () => {
      const result = await testPost.queryComments();
      
      expect(result._response).toBeDefined();
      expect(result._response.ConsumedCapacity).toBeDefined();
      expect(result._response.ConsumedCapacity).toBeInstanceOf(Object);
      expect(result._response.ConsumedCapacity.CapacityUnits).toBeGreaterThan(0);
    });

    test('should track capacity when loading related data for query results', async () => {
      // ... test setup ...
      const result = await testPost.queryComments(null, {
        loadRelated: true,
        relatedFields: ['authorId']
      });
      
      expect(result._response.ConsumedCapacity).toBeDefined();
      expect(Array.isArray(result._response.ConsumedCapacity)).toBeTruthy();
      // Initial query capacity + related loads
      expect(result._response.ConsumedCapacity.length).toBeGreaterThan(1);
    });
  });

  describe('Update Operations', () => {
    test('should track capacity for update operations', async () => {
      const result = await Comment.update(testComment.getPrimaryId(), {
        text: 'Updated Comment'
      });

      expect(result._response).toBeDefined();
      expect(result._response.ConsumedCapacity).toBeDefined();
      expect(result._response.ConsumedCapacity).toBeInstanceOf(Object);
      expect(result._response.ConsumedCapacity.CapacityUnits).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty related data gracefully', async () => {
      const comment = await Comment.find(testComment.getPrimaryId());
      // Try to load a non-existent related field
      await comment.loadRelatedData(['nonexistentField']);
      
      expect(comment._response).toBeDefined();
      expect(comment._response.ConsumedCapacity).toBeDefined();
      // Should only have capacity from the initial find operation
      expect(comment._response.ConsumedCapacity.length).toBe(1);
    });

    test('should track capacity when loading related data returns null', async () => {
      // Create a comment with non-existent authorId
      const orphanComment = await Comment.create({
        postId: testPost.postId,
        authorId: 'nonexistent-user-id',
        text: 'Orphan Comment'
      });

      await orphanComment.loadRelatedData(['authorId']);
      
      expect(orphanComment._response.ConsumedCapacity).toBeDefined();
      expect(orphanComment._response.ConsumedCapacity.length).toBe(2); // Initial create + failed load
      orphanComment._response.ConsumedCapacity.forEach(capacity => {
        expect(capacity.CapacityUnits).toBeGreaterThan(0);
      });
    });

    test('should accumulate capacity for repeated related data loads', async () => {
      const comment = await Comment.find(testComment.getPrimaryId());
      
      // Load related data multiple times
      await comment.loadRelatedData(['authorId']);
      const firstLoadCapacity = comment._response.ConsumedCapacity.length;
      
      await comment.loadRelatedData(['postId']);
      const secondLoadCapacity = comment._response.ConsumedCapacity.length;
      
      expect(secondLoadCapacity).toBeGreaterThan(firstLoadCapacity);
      expect(comment._response.ConsumedCapacity.length).toBe(3); // Initial + authorId + postId
    });
  });
}); 