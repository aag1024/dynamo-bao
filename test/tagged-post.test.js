const { User, Post, Tag, TaggedPost } = require('../src');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { cleanupTestData } = require('./utils/test-utils');
require('dotenv').config();

describe('TaggedPost Queries', () => {
  let docClient;
  let testUser, testPost1, testPost2, testTag1, testTag2;

  beforeAll(async () => {
    const client = new DynamoDBClient({ region: process.env.AWS_REGION });
    docClient = DynamoDBDocument.from(client);
    
    User.initTable(docClient, process.env.TABLE_NAME);
    Post.initTable(docClient, process.env.TABLE_NAME);
    Tag.initTable(docClient, process.env.TABLE_NAME);
    TaggedPost.initTable(docClient, process.env.TABLE_NAME);
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

    // Create test posts
    [testPost1, testPost2] = await Promise.all([
      Post.create({
        userId: testUser.userId,
        title: 'Test Post 1',
        content: 'Content 1'
      }),
      Post.create({
        userId: testUser.userId,
        title: 'Test Post 2',
        content: 'Content 2'
      })
    ]);

    // Create test tags
    [testTag1, testTag2] = await Promise.all([
      Tag.create({ name: 'Tag1' }),
      Tag.create({ name: 'Tag2' })
    ]);

    // Create tagged posts relationships
    await Promise.all([
      TaggedPost.create({
        tagId: testTag1.tagId,
        postId: testPost1.postId
      }),
      TaggedPost.create({
        tagId: testTag1.tagId,
        postId: testPost2.postId
      }),
      TaggedPost.create({
        tagId: testTag2.tagId,
        postId: testPost1.postId
      })
    ]);
  });

  afterEach(async () => {
    await cleanupTestData(docClient, process.env.TABLE_NAME);
  });

  test('should query posts for a tag using primary key', async () => {
    const tag = await Tag.find(testTag1.tagId);
    const posts = await tag.queryPosts();
    
    expect(posts.items).toHaveLength(2);
    expect(posts.items.map(p => p.postId).sort()).toEqual(
      [testPost1.postId, testPost2.postId].sort()
    );
  });

  test('should query tags for a post using GSI', async () => {
    const post = await Post.find(testPost1.postId);
    const tags = await post.queryTags();
    
    expect(tags.items).toHaveLength(2);
    expect(tags.items.map(t => t.tagId).sort()).toEqual(
      [testTag1.tagId, testTag2.tagId].sort()
    );
  });

  test('should query recent posts for a tag', async () => {
    const tag = await Tag.find(testTag1.tagId);
    const recentPosts = await tag.queryRecentPosts();
    
    expect(recentPosts.items).toHaveLength(2);
    expect(recentPosts.items[0].createdAt.getTime())
      .toBeGreaterThanOrEqual(recentPosts.items[1].createdAt.getTime());
  });

  test('should handle pagination for posts by tag', async () => {
    const tag = await Tag.find(testTag1.tagId);
    const firstPage = await tag.queryPosts({ limit: 1 });
    
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.lastEvaluatedKey).toBeDefined();

    const secondPage = await tag.queryPosts({ 
      limit: 2, 
      startKey: firstPage.lastEvaluatedKey 
    });
    
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.lastEvaluatedKey).toBeUndefined();
    
    // Verify we got different posts
    expect(firstPage.items[0].postId).not.toBe(secondPage.items[0].postId);
  });

  test('should return empty results for tag with no posts', async () => {
    const emptyTag = await Tag.create({ name: 'Empty Tag' });
    const posts = await emptyTag.queryPosts();
    
    expect(posts.items).toHaveLength(0);
    expect(posts.lastEvaluatedKey).toBeUndefined();
  });

  test('should return empty results for post with no tags', async () => {
    const untaggedPost = await Post.create({
      userId: testUser.userId,
      title: 'Untagged Post',
      content: 'No Tags'
    });
    
    const tags = await untaggedPost.queryTags();
    
    expect(tags.items).toHaveLength(0);
    expect(tags.lastEvaluatedKey).toBeUndefined();
  });
}); 