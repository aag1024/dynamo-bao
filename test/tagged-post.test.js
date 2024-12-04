const dynamoBao = require('../src');
const testConfig = require('./config');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');
const { defaultLogger: logger } = require('../src/utils/logger');

let testId;

describe('TaggedPost Queries', () => {
  let testUser, testPost1, testPost2, testTag1, testTag2;

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
    Tag = manager.getModel('Tag');
    TaggedPost = manager.getModel('TaggedPost');

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

    await new Promise(resolve => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    if (testId) {
        await cleanupTestData(testId);
        await verifyCleanup(testId);
      }
  });

  test('should query posts for a tag using primary key', async () => {
    const tag = await Tag.find(testTag1.tagId);
    expect(tag.tagId).toBe(testTag1.tagId);

    const posts = await tag.queryPosts();
    logger.log("Query posts:", posts);
    
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
      .toBeLessThanOrEqual(recentPosts.items[1].createdAt.getTime());
  });

  test('should handle pagination for posts by tag', async () => {
    const tag = await Tag.find(testTag1.tagId);
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