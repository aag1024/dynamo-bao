const dynamoBao = require('dynamo-bao');
const testConfig = require('../config');
const { cleanupTestData, verifyCleanup } = require('../utils/test-utils');
const { ulid } = require('ulid');
const { Post } = require('./generated/post');

let testId;

describe('Generated Post Model', () => {
  beforeEach(async () => {
    testId = ulid();
  
    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId
    });

    // Register the Post model
    manager.registerModel(Post);

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test('should create a post', async () => {
    const post = await Post.create({
      title: 'Test Post',
      content: 'Test Content',
      userId: 'user123'
    });

    expect(post.title).toBe('Test Post');
    expect(post.content).toBe('Test Content');
    expect(post.userId).toBe('user123');
    expect(post.postId).toBeTruthy(); // Should auto-generate
    expect(post.createdAt).toBeTruthy();
  });

  test('should validate required fields', async () => {
    await expect(async () => {
      await Post.create({
        content: 'Test Content'
        // Missing title and userId
      });
    }).rejects.toThrow();
  });

  test('should support indexes', async () => {
    const post = await Post.create({
      title: 'Test Post',
      content: 'Test Content',
      userId: 'user123'
    });

    // Verify GSI keys are in _data
    let gsi1_pk = `[${testId}]#p#gsi1#p`
    expect(post._data._gsi1_pk).toBe(gsi1_pk); // modelPrefix
    expect(post._data._gsi1_sk).toBe(post.postId);

    let gsi2_pk = `[${testId}]#p#gsi2#user123`
    expect(post._data._gsi2_pk).toBe(gsi2_pk);
    expect(post._data._gsi2_sk).toBeTruthy(); // createdAt should be set
  });

  test('should find post by id', async () => {
    const created = await Post.create({
      title: 'Test Post',
      content: 'Test Content',
      userId: 'user123'
    });

    const found = await Post.find(created.postId);
    expect(found.title).toBe('Test Post');
    expect(found.content).toBe('Test Content');
  });

  test('should update post', async () => {
    const post = await Post.create({
      title: 'Test Post',
      content: 'Test Content',
      userId: 'user123'
    });

    const updated = await Post.update(post.postId, {
      title: 'Updated Title'
    });

    expect(updated.title).toBe('Updated Title');
    expect(updated.content).toBe('Test Content'); // Unchanged
  });
});
