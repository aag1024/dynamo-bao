const { User, Post, Tag, TaggedPost, GSI_INDEX_ID1 } = require('../src');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { cleanupTestData } = require('./utils/test-utils');
require('dotenv').config();

describe('TaggedPost Queries', () => {
  let docClient;
  let testPost, testTag1, testTag2;

  beforeAll(async () => {
    // Initialize DynamoDB client
    const client = new DynamoDBClient({ region: process.env.AWS_REGION });
    docClient = DynamoDBDocument.from(client);
    
    // Initialize all required models
    User.initTable(docClient, process.env.TABLE_NAME);
    Post.initTable(docClient, process.env.TABLE_NAME);
    Tag.initTable(docClient, process.env.TABLE_NAME);
    TaggedPost.initTable(docClient, process.env.TABLE_NAME);
  });

  beforeEach(async () => {
    await cleanupTestData(docClient, process.env.TABLE_NAME);

    // Create test user (required for post creation)
    const testUser = await User.create({
      name: 'Test User',
      email: `test${Date.now()}@example.com`,
      external_id: `ext${Date.now()}`,
      external_platform: 'platform1',
      role: 'user',
      status: 'active'
    });

    // Create test data
    testPost = await Post.create({
      userId: testUser.userId,
      title: 'Test Post',
      content: 'Test Content'
    });

    testTag1 = await Tag.create({ name: 'Tag1' });
    testTag2 = await Tag.create({ name: 'Tag2' });

    // Create tagged posts
    await Promise.all([
      TaggedPost.create({
        tagId: testTag1.tagId,
        postId: testPost.postId
      }),
      TaggedPost.create({
        tagId: testTag2.tagId,
        postId: testPost.postId
      })
    ]);
  });

  afterEach(async () => {
    await cleanupTestData(docClient, process.env.TABLE_NAME);
  });

  test('should query posts by tag using primary key', async () => {
    const result = await TaggedPost.queryByIndex('postsByTag', testTag1.tagId);
    
    expect(result.items).toHaveLength(1);
    expect(result.items[0].tagId).toBe(testTag1.tagId);
    expect(result.items[0].postId).toBe(testPost.postId);
    
    // No limit was set, so no pagination
    expect(result.lastEvaluatedKey).toBeUndefined();
  });

  test('should query tags by post using GSI', async () => {
    const result = await TaggedPost.queryByIndex('tagsByPost', testPost.postId);
    
    expect(result.items).toHaveLength(2);
    expect(result.items.map(item => item.tagId)).toContain(testTag1.tagId);
    expect(result.items.map(item => item.tagId)).toContain(testTag2.tagId);
  });

  test('should format keys correctly with model prefix', async () => {
    // Query using the primary key as an index
    const result = await TaggedPost.queryByIndex('postsByTag', testTag1.tagId);
    
    expect(result.items).toHaveLength(1);
    const taggedPost = result.items[0];
    
    // Check that we can access both the model properties and raw data
    expect(taggedPost.tagId).toBe(testTag1.tagId);
    expect(taggedPost.data._pk).toBe(`tp#${testTag1.tagId}`);
    
    // Query using the GSI
    const gsiResult = await TaggedPost.queryByIndex('tagsByPost', testPost.postId);
    expect(gsiResult.items).toHaveLength(2);
    const gsiTaggedPost = gsiResult.items[0];
    
    // Check GSI key format
    const expectedGsiKey = `tp#${GSI_INDEX_ID1}#${testPost.postId}`;
    expect(gsiTaggedPost.data[`_${GSI_INDEX_ID1}_pk`]).toBe(expectedGsiKey);
  });
}); 