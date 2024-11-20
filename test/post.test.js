const { User, Post } = require('../src');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
require('dotenv').config();

let docClient;
let testUser;

describe('Post Model', () => {
  beforeAll(async () => {
    const client = new DynamoDBClient({ region: process.env.AWS_REGION });
    docClient = DynamoDBDocument.from(client);
    
    // Initialize both models
    User.initTable(docClient, process.env.TABLE_NAME);
    Post.initTable(docClient, process.env.TABLE_NAME);

    // Verify models are registered
    const registry = require('../src/model-registry').ModelRegistry.getInstance();
    console.log('Registered models:', registry.listModels());
  });

  beforeEach(async () => {
    await cleanupTestData(docClient, process.env.TABLE_NAME);
    await verifyCleanup(docClient, process.env.TABLE_NAME);

    // Create a test user for each test
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com',
      external_id: 'ext1',
      external_platform: 'platform1',
      role: 'user',
      status: 'active'
    });
  });

  afterEach(async () => {
    await cleanupTestData(docClient, process.env.TABLE_NAME);
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
      expect(user.email).toBe('test@example.com');
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
}); 