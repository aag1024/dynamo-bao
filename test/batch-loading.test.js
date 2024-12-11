const dynamoBao = require('../src');
const testConfig = require('./config');
const { BaseModel, PrimaryKeyConfig, IndexConfig } = require('../src/model');
const { StringField, RelatedField } = require('../src/fields');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');


// Define test models
class Organization extends BaseModel {
  static modelPrefix = 'org';
  
  static fields = {
    organizationId: StringField({ required: true }),
    name: StringField({ required: true }),
    status: StringField({ required: true })
  };

  static primaryKey = PrimaryKeyConfig('organizationId');
  
  static indexes = {
    statusIndex: IndexConfig('status', 'organizationId', 'gsi1')
  };
}

class User extends BaseModel {
  static modelPrefix = 'usr';
  
  static fields = {
    userId: StringField({ required: true }),
    organizationId: RelatedField('Organization', { required: true }),
    name: StringField({ required: true }),
    email: StringField({ required: true }),
    externalId: StringField({ required: true }),
    externalPlatform: StringField({ required: true }),
    role: StringField({ required: true }),
    status: StringField({ required: true })
  };

  static primaryKey = PrimaryKeyConfig('userId');
  
  static indexes = {
    statusIndex: IndexConfig('status', 'userId', 'gsi1')
  };
}

class Post extends BaseModel {
  static modelPrefix = 'pst';
  
  static fields = {
    postId: StringField({ required: true }),
    userId: RelatedField('User', { required: true }),
    title: StringField({ required: true }),
    content: StringField({ required: true }),
    status: StringField({ defaultValue: 'active' })
  };

  static primaryKey = PrimaryKeyConfig('postId');
  
  static indexes = {
    statusIndex: IndexConfig('status', 'postId', 'gsi1')
  };
}

describe('Batch Loading and Related Data', () => {
  let testId, testOrgs, testUsers, testPosts;
  const NUM_ORGS = 3;
  const USERS_PER_ORG = 10;
  const POSTS_PER_USER = 5;

  beforeEach(async () => {
    testId = ulid();
    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId
    });

    // Register the test models
    manager.registerModel(Organization);
    manager.registerModel(User);
    manager.registerModel(Post);

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    // Create test organizations
    testOrgs = await Promise.all(
      Array(NUM_ORGS).fill().map((_, i) => Organization.create({
        organizationId: ulid(),
        name: `Test Org ${i}`,
        status: 'active'
      }))
    );

    // Create test users for each org
    testUsers = [];
    for (const org of testOrgs) {
      const orgUsers = await Promise.all(
        Array(USERS_PER_ORG).fill().map((_, i) => User.create({
          userId: ulid(),
          organizationId: org.organizationId,
          name: `Test User ${i}`,
          email: `test${Date.now()}-${i}@example.com`,
          externalId: `ext${Date.now()}-${i}`,
          externalPlatform: 'platform1',
          role: 'user',
          status: 'active'
        }))
      );
      testUsers.push(...orgUsers);
    }

    // Create test posts for each user
    testPosts = [];
    for (const user of testUsers) {
      const userPosts = await Promise.all(
        Array(POSTS_PER_USER).fill().map((_, i) => Post.create({
          postId: ulid(),
          userId: user.userId,
          title: `Post ${i} by ${user.name}`,
          content: `Content ${i}`,
          status: 'active'
        }))
      );
      testPosts.push(...userPosts);
    }
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test('should batch load related data efficiently during queries', async () => {
    const loaderContext = {};
    const startTime = Date.now();
    
    // Initialize an empty array to hold all posts
    let allPosts = [];
    let lastEvaluatedKey = null;

    // Keep querying until we get all posts
    do {
      const { items: posts, lastEvaluatedKey: lek } = await Post.queryByIndex(
        'statusIndex',    // indexName
        'active',         // pkValue
        null,            // skCondition
        {                // options
          loadRelated: true,
          relatedFields: ['userId'],
          loaderContext,
          startKey: lastEvaluatedKey,
          limit: 100
        }
      );

      allPosts = [...allPosts, ...posts];
      lastEvaluatedKey = lek;
    } while (lastEvaluatedKey);
    
    const duration = Date.now() - startTime;

    // Verify we got all posts
    expect(allPosts.length).toBe(NUM_ORGS * USERS_PER_ORG * POSTS_PER_USER);

    // Verify each post has its related user loaded
    for (const post of allPosts) {
      const user = post.getRelated('userId');
      expect(user).toBeDefined();
      expect(user.userId).toBe(post.userId);
    }

    // Verify loader context was used effectively
    const uniqueUserIds = new Set(allPosts.map(post => post.userId));
    const contextSize = Object.keys(loaderContext).length;
    expect(contextSize).toBe(uniqueUserIds.size);

    // Calculate consumed capacity
    const totalCapacity = allPosts.reduce((sum, post) => {
      return sum + post.getNumericConsumedCapacity('read', true);
    }, 0);

    // Log performance metrics
    // console.log('Performance metrics:', {
    //   totalPosts: allPosts.length,
    //   uniqueUsers: uniqueUserIds.size,
    //   totalDuration: duration,
    //   msPerPost: duration / allPosts.length,
    //   totalCapacityUnits: totalCapacity,
    //   capacityUnitsPerPost: totalCapacity / allPosts.length
    // });
  }, 30000);

  test('should not reload objects already in context', async () => {
    const loaderContext = {};
    
    // First load - track consumed capacity
    const testPostsSlice = testPosts.slice(0, 10);
    testPostsSlice.forEach(post => post.clearConsumedCapacity());

    const firstLoadResults = await Promise.all(testPostsSlice.map(post => 
      post.loadRelatedData(['userId'], loaderContext)
    ));
    
    const firstLoadCapacity = firstLoadResults.reduce((sum, post) => {
        const capacity = post.getNumericConsumedCapacity('read', true) || 0;
        return sum + capacity;
    }, 0);
    
    // Second load - should use context and not consume additional capacity
    const secondLoadResults = await Promise.all(testPostsSlice.map(post => 
      post.loadRelatedData(['userId'], loaderContext)
    ));
    
    const secondLoadCapacity = secondLoadResults.reduce((sum, post) => {
      const capacity = post.getNumericConsumedCapacity('read', true) || 0;
      return sum + capacity;
    }, 0);

    // Second load should show capacity from cache (should be 0 or very small)
    expect(secondLoadCapacity).toBeLessThan(firstLoadCapacity * 0.1); // Allow for some overhead
  });

  test('should batch requests within batchDelay window', async () => {
    const loaderContext = {};
    const startTime = Date.now();

    const testPostsSlice = testPosts.slice(0, 20);
    testPostsSlice.forEach(post => post.clearConsumedCapacity());

    // Start multiple loads just slightly apart
    const loadPromises = testPostsSlice.map((post, i) => 
      new Promise(resolve => 
        setTimeout(() => resolve(post.loadRelatedData(['userId'], loaderContext)), i * 2)
      )
    );

    const results = await Promise.all(loadPromises);
    const duration = Date.now() - startTime;

    // Calculate total consumed capacity
    const totalCapacity = results.reduce((sum, post) => {
      return sum + post.getNumericConsumedCapacity('read', true);
    }, 0);

    // Log batching metrics
    // console.log('Batching metrics:', {
    //   totalRequests: loadPromises.length,
    //   totalDuration: duration,
    //   msPerRequest: duration / loadPromises.length,
    //   totalCapacityUnits: totalCapacity,
    //   capacityUnitsPerRequest: totalCapacity / loadPromises.length
    // });

    // Verify capacity usage indicates batching (should be significantly less than 1 unit per request)
    expect(totalCapacity / loadPromises.length).toBeLessThan(0.5);
  });

  test('should handle duplicate requests within same batch', async () => {
    const loaderContext = {};
    const startTime = Date.now();

    // Request same user multiple times
    const user = testUsers[0];
    const duplicatePromises = Array(10).fill().map(() => 
      User.find(user.userId, { batchDelay: 50, loaderContext })
    );

    const results = await Promise.all(duplicatePromises);
    const duration = Date.now() - startTime;

    // Calculate total consumed capacity
    const totalCapacity = results.reduce((sum, result) => sum + result.getNumericConsumedCapacity('read', true), 0);

    // Verify all results are the same user
    results.forEach(result => {
      expect(result.userId).toBe(user.userId);
    });

    // Log duplicate request metrics
    // console.log('Duplicate request metrics:', {
    //   totalRequests: duplicatePromises.length,
    //   totalDuration: duration,
    //   msPerRequest: duration / duplicatePromises.length,
    //   totalCapacityUnits: totalCapacity,
    //   capacityUnitsPerRequest: totalCapacity / duplicatePromises.length
    // });

    // Verify capacity usage indicates deduplication (should be close to 1 unit total)
    expect(totalCapacity).toBeLessThan(2);
  });
});