const { 
    initModels, 
    ModelManager
} = require('../src');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');
require('dotenv').config();

describe('Related Field Queries', () => {
  let testUser, testPosts, testTags, testId;

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
    Tag = ModelManager.getInstance(testId).getModel('Tag');
    TaggedPost = ModelManager.getInstance(testId).getModel('TaggedPost');

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

    // Create test tags
    testTags = await Promise.all([
      Tag.create({ name: 'Tag 1' }),
      Tag.create({ name: 'Tag 2' })
    ]);

    // Create tag relationships
    await Promise.all([
      TaggedPost.create({
        tagId: testTags[0].tagId,
        postId: testPosts[0].postId
      }),
      TaggedPost.create({
        tagId: testTags[0].tagId,
        postId: testPosts[1].postId
      }),
      TaggedPost.create({
        tagId: testTags[1].tagId,
        postId: testPosts[0].postId
      })
    ]);
  });

  afterEach(async () => {
    if (testId) {
        await cleanupTestData(testId);
        await verifyCleanup(testId);
      }
  });

  describe('Direct Relationships', () => {
    test('should automatically generate queryPosts method for User', async () => {
      const user = await User.find(testUser.userId);
      const posts = await user.queryPosts();
      
      expect(posts.items).toHaveLength(2);
      posts.items.forEach(post => {
        expect(post.userId).toBe(testUser.userId);
      });
    });

    test('should handle pagination in direct relationships', async () => {
      const user = await User.find(testUser.userId);
      const firstPage = await user.queryPosts(null, {
        limit: 1,
        direction: 'DESC'
      });
      
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.lastEvaluatedKey).toBeDefined();

      const secondPage = await user.queryPosts(null, {
        limit: 2,
        startKey: firstPage.lastEvaluatedKey,
        direction: 'DESC'
      });
      
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.lastEvaluatedKey).toBeUndefined();
      expect(firstPage.items[0].postId).not.toBe(secondPage.items[0].postId);
    });
  });

  describe('Mapping Table Relationships', () => {
    test('should automatically generate query methods for Tag->Posts', async () => {
      const tag = await Tag.find(testTags[0].tagId);
      const posts = await tag.queryPosts();
      
      expect(posts.items).toHaveLength(2);
      const postIds = posts.items.map(p => p.postId).sort();
      const expectedPostIds = testPosts.map(p => p.postId).sort();
      expect(postIds).toEqual(expectedPostIds);
    });

    test('should automatically generate query methods for Post->Tags', async () => {
      const post = await Post.find(testPosts[0].postId);
      const tags = await post.queryTags();
      
      expect(tags.items).toHaveLength(2);
      const tagIds = tags.items.map(t => t.tagId).sort();
      const expectedTagIds = testTags.map(t => t.tagId).sort();
      expect(tagIds).toEqual(expectedTagIds);
    });

    test('should handle pagination in mapping relationships', async () => {
      const tag = await Tag.find(testTags[0].tagId);
      const firstPage = await tag.queryPosts(null, {
        limit: 1,
        direction: 'DESC'
      });
      
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.lastEvaluatedKey).toBeDefined();

      const secondPage = await tag.queryPosts(null, {
        limit: 2,
        startKey: firstPage.lastEvaluatedKey,
        direction: 'DESC'
      });
      
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.lastEvaluatedKey).toBeUndefined();
      expect(firstPage.items[0].postId).not.toBe(secondPage.items[0].postId);
    });
  });

  describe('Related Data Loading in Queries', () => {
    test('should load all related data when requested', async () => {
      const user = await User.find(testUser.userId);
      const posts = await user.queryPosts(null, {
        limit: null,
        startKey: null,
        direction: 'DESC',
        loadRelated: true 
      });
      
      posts.items.forEach(post => {
        const relatedUser = post.getRelated('userId');
        expect(relatedUser).toBeDefined();
        expect(relatedUser.userId).toBe(testUser.userId);
      });
    });

    test('should load specific related fields', async () => {
      const user = await User.find(testUser.userId);
      const posts = await user.queryPosts(null, {
        limit: null,
        direction: 'DESC',
        loadRelated: true,
        relatedFields: ['userId']
      });
      
      posts.items.forEach(post => {
        const relatedUser = post.getRelated('userId');
        expect(relatedUser).toBeDefined();
        expect(relatedUser.userId).toBe(testUser.userId);
      });
    });

    test('should work with pagination when loading related data', async () => {
      const user = await User.find(testUser.userId);
      const firstPage = await user.queryPosts(null, {
        limit: 1,
        direction: 'DESC',
        loadRelated: true 
      });
      
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.lastEvaluatedKey).toBeDefined();
      expect(firstPage.items[0].getRelated('userId')).toBeDefined();

      const secondPage = await user.queryPosts(null, {
        limit: 1,
        startKey: firstPage.lastEvaluatedKey,
        direction: 'DESC',
        loadRelated: true 
      });
      
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0].getRelated('userId')).toBeDefined();
      expect(firstPage.items[0].postId).not.toBe(secondPage.items[0].postId);
    });
  });
}); 