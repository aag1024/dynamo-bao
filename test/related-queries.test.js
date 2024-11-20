const { User, Post } = require('../src');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
require('dotenv').config();

let docClient;
let testUser;

describe('Related Field Queries', () => {
  beforeAll(async () => {
    const client = new DynamoDBClient({ region: process.env.AWS_REGION });
    docClient = DynamoDBDocument.from(client);
    
    User.initTable(docClient, process.env.TABLE_NAME);
    Post.initTable(docClient, process.env.TABLE_NAME);
  });

  beforeEach(async () => {
    await cleanupTestData(docClient, process.env.TABLE_NAME);
    
    // Create test user
    testUser = await User.create({
      name: 'Test User',
      email: `test${Date.now()}@example.com`,
      external_id: `ext${Date.now()}`,
      external_platform: 'platform1',
      role: 'user',
      status: 'active'
    });

    // Create some test posts
    await Promise.all([
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
    await cleanupTestData(docClient, process.env.TABLE_NAME);
  });

  test('should automatically generate queryPosts method', async () => {
    const user = await User.find(testUser.userId);
    console.log('Test user:', user);
    
    // Log the test posts
    const allPosts = await Post.queryByIndex('allPosts', 'p');
    console.log('All posts:', allPosts);
    
    const posts = await user.queryPosts();
    console.log('User posts:', posts);
    
    expect(posts.items).toHaveLength(2);
    posts.items.forEach(post => {
      expect(post.userId).toBe(testUser.userId);
    });
  });

  test('should query related posts with pagination', async () => {
    const user = await User.find(testUser.userId);
    console.log('Test user:', JSON.stringify(user, null, 2));
    
    // First page with limit 1
    const firstPage = await Post.queryByIndex('postsForUser', user.userId, { limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.lastEvaluatedKey).toBeDefined();

    // Second page should be the last page
    const secondPage = await Post.queryByIndex('postsForUser', user.userId, { 
      limit: 2, 
      startKey: firstPage.lastEvaluatedKey 
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.lastEvaluatedKey).toBeUndefined();
  });

  test('should support different sort directions', async () => {
    const user = await User.find(testUser.userId);
    
    const ascPosts = await user.queryPosts({ direction: 'ASC' });
    const descPosts = await user.queryPosts({ direction: 'DESC' });
    
    expect(ascPosts.items).toHaveLength(2);
    expect(descPosts.items).toHaveLength(2);
    
    // Check that the order is reversed
    expect(ascPosts.items[0].postId).toBe(descPosts.items[1].postId);
    expect(ascPosts.items[1].postId).toBe(descPosts.items[0].postId);
  });

  test('should support date range filtering with custom keys', async () => {
    const user = await User.find(testUser.userId);
    
    // Clean up existing posts from beforeEach
    await cleanupTestData(docClient, process.env.TABLE_NAME);
    
    // Create test data with specific dates
    const lastMonth = new Date('2024-10-20T00:00:00Z');
    const thisMonth1 = new Date('2024-11-15T00:00:00Z');
    const thisMonth2 = new Date('2024-11-16T00:00:00Z');
    const nextMonth = new Date('2024-12-20T00:00:00Z');

    await Promise.all([
      // Old post
      Post.create({
        userId: testUser.userId,
        title: 'Old Post',
        content: 'Old Content',
        createdAt: lastMonth
      }),
      // Current month posts
      Post.create({
        userId: testUser.userId,
        title: 'Post 1',
        content: 'Content 1',
        createdAt: thisMonth1
      }),
      Post.create({
        userId: testUser.userId,
        title: 'Post 2',
        content: 'Content 2',
        createdAt: thisMonth2
      }),
      // Future post
      Post.create({
        userId: testUser.userId,
        title: 'Future Post',
        content: 'Future Content',
        createdAt: nextMonth
      })
    ]);

    // Find posts from this month only
    const thisMonth = new Date('2024-11-01T00:00:00Z');
    const nextMonthStart = new Date('2024-12-01T00:00:00Z');

    const thisMonthPosts = await Post.queryByIndex('postsForUser', testUser.userId, {
      rangeKey: 'createdAt',
      rangeCondition: 'BETWEEN',
      rangeValue: thisMonth,
      endRangeValue: nextMonthStart
    });

    expect(thisMonthPosts.items).toHaveLength(2);
    thisMonthPosts.items.forEach(post => {
      const postDate = post.createdAt.getTime();
      expect(postDate).toBeGreaterThanOrEqual(thisMonth.getTime());
      expect(postDate).toBeLessThan(nextMonthStart.getTime());
    });
  });
}); 