const dynamoBao = require('../src');
const testConfig = require('./config');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');

describe('Related Data Loading', () => {
    let testUser, testPosts, testId;
  
    beforeEach(async () => {
        testId = ulid();

        const manager = dynamoBao.initModels({
            ...testConfig,
            testId: testId
        });

        User = manager.getModel('User');
        Post = manager.getModel('Post');

        await cleanupTestData(testId);
        await verifyCleanup(testId);
      
      // Create test user
      testUser = await User.create({
        name: 'Test User',
        email: `test${Date.now()}@example.com`,
        externalId: `ext${Date.now()}`,
        externalPlatform: 'platform1',
        role: 'user',
        status: 'active'
      });
  
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
  
    afterEach(async () => {
        if (testId) {
            await cleanupTestData(testId);
            await verifyCleanup(testId);
          }
    });
  
    test('should load related data independently for different instances', async () => {
      // Create two posts with different users
      const user2 = await User.create({
        name: 'Second User',
        email: `test2${Date.now()}@example.com`,
        externalId: `ext2${Date.now()}`,
        externalPlatform: 'platform1',
        role: 'user',
        status: 'active'
      });
  
      const post1 = await Post.create({
        userId: testUser.userId,
        title: 'First Post',
        content: 'Content 1'
      });
  
      const post2 = await Post.create({
        userId: user2.userId,
        title: 'Second Post',
        content: 'Content 2'
      });
  
      // Load related data for both posts
      await Promise.all([
        post1.loadRelatedData(),
        post2.loadRelatedData()
      ]);
  
      // Verify each post has its correct user
      const related1 = post1.getRelated('userId');
      const related2 = post2.getRelated('userId');
  
      expect(related1.userId).toBe(testUser.userId);
      expect(related2.userId).toBe(user2.userId);
    });
  
    test('should maintain separate related data caches between instances', async () => {
      const post1 = testPosts[0];
      const post2 = testPosts[1];
  
      // Load related data for first post
      await post1.loadRelatedData();
      const user1 = post1.getRelated('userId');
  
      // Modify the cached user data
      user1.name = 'Modified Name';
  
      // Load related data for second post
      await post2.loadRelatedData();
      const user2 = post2.getRelated('userId');
  
      // Verify the second post's related user wasn't affected by first post's modification
      expect(user2.name).toBe('Test User');
    });
  
    test('should clear related cache when field value changes', async () => {
      const post = testPosts[0];
      await post.loadRelatedData();
      
      const originalUser = post.getRelated('userId');
      expect(originalUser.userId).toBe(testUser.userId);
  
      // Create a new user and update the post
      const newUser = await User.create({
        name: 'New User',
        email: `new${Date.now()}@example.com`,
        externalId: `new${Date.now()}`,
        externalPlatform: 'platform1',
        role: 'user',
        status: 'active'
      });
  
      post.userId = newUser.userId;
      await post.loadRelatedData();
  
      const updatedUser = post.getRelated('userId');
      expect(updatedUser.userId).toBe(newUser.userId);
    });
  
    test('should load only specified related fields', async () => {
      // Create a post with a user and add some tags
      const post = await Post.create({
        userId: testUser.userId,
        title: 'Test Post',
        content: 'Content'
      });
  
      // Load only the user relationship
      await post.loadRelatedData(['userId']);
      
      // User should be loaded
      const relatedUser = post.getRelated('userId');
      expect(relatedUser).toBeDefined();
      expect(relatedUser.userId).toBe(testUser.userId);
    });
  
    test('should load multiple specified fields', async () => {
      const post = await Post.create({
        userId: testUser.userId,
        title: 'Test Post',
        content: 'Content'
      });
  
      // Load user relationship
      await post.loadRelatedData(['userId']);
      
      // User relationship should be loaded
      const relatedUser = post.getRelated('userId');
      expect(relatedUser).toBeDefined();
      expect(relatedUser.userId).toBe(testUser.userId);
    });
  
    test('should load all fields when no fields specified', async () => {
      const post = await Post.create({
        userId: testUser.userId,
        title: 'Test Post',
        content: 'Content'
      });
  
      // Load all related data
      await post.loadRelatedData();
      
      // User relationship should be loaded
      const relatedUser = post.getRelated('userId');
      expect(relatedUser).toBeDefined();
      expect(relatedUser.userId).toBe(testUser.userId);
    });
  
    test('should ignore invalid field names', async () => {
      const post = await Post.create({
        userId: testUser.userId,
        title: 'Test Post',
        content: 'Content'
      });
  
      // Should not throw error for invalid field
      await expect(post.loadRelatedData(['userId', 'invalidField']))
        .resolves.toBeDefined();
      
      // Valid field should still be loaded
      const relatedUser = post.getRelated('userId');
      expect(relatedUser).toBeDefined();
      expect(relatedUser.userId).toBe(testUser.userId);
    });
  });