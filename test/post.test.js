const { 
  initModels, 
  ModelManager,
} = require('../src');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');
require('dotenv').config();
const { defaultLogger: logger } = require('../src/utils/logger');

let testUser, testId;

describe('Post Model', () => {
  beforeEach(async () => {
    testId = ulid();
  
    initModels({
      region: process.env.AWS_REGION,
      tableName: process.env.TABLE_NAME,
      test_id: testId
    });

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    User = ModelManager.getInstance(testId).getModel('User');
    Post = ModelManager.getInstance(testId).getModel('Post');

    // Create a test user with unique values for each test
    testUser = await User.create({
      name: 'Test User',
      email: `test${Date.now()}@example.com`, // Make email unique
      externalId: `ext${Date.now()}`, // Make externalId unique
      externalPlatform: 'platform1',
      role: 'user',
      status: 'active'
    });
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  describe('RelatedField - User', () => {
    test('should create post with user ID', async () => {
      const post = await Post.create({
        title: 'Test Post',
        content: 'Test Content',
        userId: testUser.userId
      });

      expect(post.userId).toBe(testUser.userId);
      expect(post.title).toBe('Test Post');
      expect(post.content).toBe('Test Content');
      expect(post.createdAt).toBeInstanceOf(Date);
    });

    test('should automatically generate getUser method', async () => {
      const post = await Post.create({
        title: 'Test Post',
        content: 'Test Content',
        userId: testUser.userId
      });

      // Verify the method exists
      expect(typeof post.getUser).toBe('function');

      // Test the getter
      const user = await post.getUser();
      expect(user).toBeTruthy();
      expect(user.userId).toBe(testUser.userId);
      expect(user.name).toBe('Test User');
      expect(user.email).toBeTruthy();
      expect(user.email).toMatch(/@example.com$/);
    });

    test('should cache related user after first load', async () => {
      const post = await Post.create({
        title: 'Test Post',
        content: 'Test Content',
        userId: testUser.userId
      });

      // First call should load from DB
      const user1 = await post.getUser();
      expect(user1.userId).toBe(testUser.userId);

      // Mock the find method to verify it's not called again
      const findSpy = jest.spyOn(User, 'find');
      
      // Second call should use cached value
      const user2 = await post.getUser();
      expect(user2.userId).toBe(testUser.userId);
      expect(findSpy).not.toHaveBeenCalled();

      findSpy.mockRestore();
    });

    test('should handle missing user gracefully with getter', async () => {
      const post = await Post.create({
        title: 'Test Post',
        content: 'Test Content',
        userId: testUser.userId
      });

      // Delete the user and clear the cache
      await User.delete(testUser.userId);
      post.clearRelatedCache('userId');

      const user = await post.getUser();
      expect(user).toBeNull();
    });

    test('should accept user instance for userId with getter', async () => {
      const post = await Post.create({
        title: 'Test Post',
        content: 'Test Content',
        userId: testUser // Pass user instance instead of ID
      });

      expect(post.userId).toBe(testUser.userId);

      // Clear any cached instances to ensure fresh load
      post.clearRelatedCache('userId');

      // Verify we can still use the getter
      const user = await post.getUser();
      expect(user.userId).toBe(testUser.userId);
    });
  });

  describe('Post Queries', () => {
    let testPosts;

    beforeEach(async () => {
      // Verify no existing posts
      const existingPosts = await Post.queryByIndex('allPosts', 'p');
      expect(existingPosts.items).toHaveLength(0);

      // Create test posts
      testPosts = await Promise.all([
        Post.create({
          userId: testUser.userId,
          title: 'Post 1',
          content: 'Content 1'
        }),
        Post.create({
          userId: testUser.userId,
          title: 'Post 2',
          content: 'Content 2'
        })
      ]);
    });

    test('should query all posts using allPosts index', async () => {
      logger.log('Post.indexes:', Post.indexes);
      logger.log('Post.modelPrefix:', Post.modelPrefix);
      const result = await Post.queryByIndex('allPosts', 'p');
      logger.log('Query result:', JSON.stringify(result, null, 2));
      expect(result.items).toHaveLength(2);
      expect(result.items[0].title).toBeDefined();
    });

    test('should query posts by user using postsForUser index', async () => {
      const result = await Post.queryByIndex('postsForUser', testUser.userId);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].userId).toBe(testUser.userId);
    });

    test('should return empty array for user with no posts', async () => {
      const anotherUser = await User.create({
        name: 'Another User',
        email: `another${Date.now()}@example.com`, // Make email unique
        externalId: `ext${Date.now()}2`, // Make externalId unique
        externalPlatform: 'platform1',
        role: 'user',
        status: 'active'
      });

      const result = await Post.queryByIndex('postsForUser', anotherUser.userId);
      expect(result.items).toHaveLength(0);
    });
  });
}); 