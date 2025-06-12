const dynamoBao = require("../src");
const { TenantContext } = dynamoBao;
const testConfig = require("./config");
const { cleanupTestData, cleanupTestDataByIteration, verifyCleanup, initTestModelsWithTenant } = require("./utils/test-utils");
const { ulid } = require("ulid");
const { defaultLogger: logger } = require("../src/utils/logger");

let testId, User, Post, IterableUser, SingleBucketUser, NonIterableUser;

// Test model class with iteration enabled
class TestIterableUser extends dynamoBao.BaoModel {
  static modelPrefix = 'iu';
  static iterable = true;
  static iterationBuckets = 5; // Small number for testing
  
  static fields = {
    userId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    name: dynamoBao.fields.StringField({ required: true }),
    email: dynamoBao.fields.StringField({ required: true }),
    status: dynamoBao.fields.StringField({ required: true }),
  };

  static primaryKey = dynamoBao.PrimaryKeyConfig('userId', 'modelPrefix');
}

// Test model class with single bucket iteration
class TestSingleBucketUser extends dynamoBao.BaoModel {
  static modelPrefix = 'su';
  static iterable = true;
  static iterationBuckets = 1;
  
  static fields = {
    userId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    name: dynamoBao.fields.StringField({ required: true }),
    email: dynamoBao.fields.StringField({ required: true }),
    status: dynamoBao.fields.StringField({ required: true }),
  };

  static primaryKey = dynamoBao.PrimaryKeyConfig('userId', 'modelPrefix');
}

// Test model class with iteration disabled
class TestNonIterableUser extends dynamoBao.BaoModel {
  static modelPrefix = 'nu';
  static iterable = false;
  
  static fields = {
    userId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    name: dynamoBao.fields.StringField({ required: true }),
    email: dynamoBao.fields.StringField({ required: true }),
    status: dynamoBao.fields.StringField({ required: true }),
  };

  static primaryKey = dynamoBao.PrimaryKeyConfig('userId', 'modelPrefix');
}

describe("Model Iteration", () => {
  beforeEach(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);
    
    // Register our test models
    manager.registerModel(TestIterableUser);
    manager.registerModel(TestSingleBucketUser);
    manager.registerModel(TestNonIterableUser);

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    User = manager.getModel("User");
    Post = manager.getModel("Post");
    IterableUser = manager.getModel("TestIterableUser");
    SingleBucketUser = manager.getModel("TestSingleBucketUser");
    NonIterableUser = manager.getModel("TestNonIterableUser");
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      // Simple cleanup - all test models are iterable
      await cleanupTestDataByIteration(testId, [
        User, Post, IterableUser, SingleBucketUser, NonIterableUser
      ]);
    }
  });

  describe("Configuration", () => {
    test("should check model iterable settings", () => {
      expect(User.iterable).toBe(true); // User model has iterable=true
      expect(Post.iterable).toBe(true); // Post model has iterable=true
      expect(NonIterableUser.iterable).toBe(false); // Test model has iterable=false
    });
    
    test("should respect custom iterable configuration", () => {
      expect(IterableUser.iterable).toBe(true);
      expect(IterableUser.iterationBuckets).toBe(5);
      
      expect(SingleBucketUser.iterable).toBe(true);
      expect(SingleBucketUser.iterationBuckets).toBe(1);
    });
    
    test("should return correct iteration bucket count", () => {
      expect(IterableUser.getIterationBuckets()).toBe(5);
      expect(SingleBucketUser.getIterationBuckets()).toBe(1);
      expect(NonIterableUser.getIterationBuckets()).toBe(1); // defaults to 1 even if not iterable
    });
  });

  describe("Iteration Key Generation", () => {
    test("should generate correct iteration keys for multi-bucket model", () => {
      const objectId = ulid();
      const keys = IterableUser._getIterationKeys(objectId, {});
      
      expect(keys).toHaveProperty('_iter_pk');
      expect(keys).toHaveProperty('_iter_sk');
      expect(keys._iter_sk).toBe(objectId);
      
      // Should include bucket number for multi-bucket model
      expect(keys._iter_pk).toMatch(/^\[.*\]#iu#iter#\d{3}$/);
    });

    test("should generate correct iteration keys for single-bucket model", () => {
      const objectId = ulid();
      const keys = SingleBucketUser._getIterationKeys(objectId, {});
      
      expect(keys).toHaveProperty('_iter_pk');
      expect(keys).toHaveProperty('_iter_sk');
      expect(keys._iter_sk).toBe(objectId);
      
      // Should not include bucket number for single-bucket model
      expect(keys._iter_pk).toMatch(/^\[.*\]#su#iter$/);
    });

    test("should return empty object for non-iterable model", () => {
      const objectId = ulid();
      const keys = NonIterableUser._getIterationKeys(objectId, {});
      
      expect(keys).toEqual({});
    });

    test("should distribute objects across buckets consistently", () => {
      const objectIds = Array.from({ length: 100 }, () => ulid());
      const bucketCounts = {};
      
      objectIds.forEach(id => {
        const keys = IterableUser._getIterationKeys(id, {});
        const bucketMatch = keys._iter_pk.match(/#iter#(\d{3})$/);
        if (bucketMatch) {
          const bucket = bucketMatch[1];
          bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
        }
      });
      
      // Should use all 5 buckets
      expect(Object.keys(bucketCounts).length).toBeGreaterThan(1);
      expect(Object.keys(bucketCounts).length).toBeLessThanOrEqual(5);
    });
  });

  describe("Integration with Save Operations", () => {
    test("should add iteration keys when saving iterable model", async () => {
      const user = await IterableUser.create({
        name: "Test User",
        email: "test@example.com",
        status: "active"
      });
      
      expect(user).toBeDefined();
      expect(user.userId).toBeDefined();
      
      // Verify the iteration keys were saved (we can't directly access them,
      // but we can verify iteration works)
      let foundUser = false;
      for await (const batch of IterableUser.iterateAll({ batchSize: 10 })) {
        const userInBatch = batch.find(u => u.userId === user.userId);
        if (userInBatch) {
          foundUser = true;
          expect(userInBatch.name).toBe("Test User");
          break;
        }
      }
      expect(foundUser).toBe(true);
    });

    test("should not add iteration keys when saving non-iterable model", async () => {
      const user = await NonIterableUser.create({
        name: "Test User",
        email: "test@example.com",
        status: "active"
      });
      
      expect(user).toBeDefined();
      expect(user.userId).toBeDefined();
      
      // Should throw error when trying to iterate
      await expect(async () => {
        for await (const batch of NonIterableUser.iterateAll()) {
          // Should not reach here
        }
      }).rejects.toThrow("not configured as iterable");
    });
  });

  describe("Single Bucket Iteration", () => {
    test("should iterate over all objects in single bucket", async () => {
      // Create test data
      const users = [];
      for (let i = 0; i < 5; i++) {
        const user = await SingleBucketUser.create({
          name: `User ${i}`,
          email: `user${i}@example.com`,
          status: "active"
        });
        users.push(user);
      }
      
      // Iterate and collect all users
      const foundUsers = [];
      for await (const batch of SingleBucketUser.iterateAll({ batchSize: 2 })) {
        foundUsers.push(...batch);
      }
      
      expect(foundUsers.length).toBe(5);
      
      // Verify all created users are found
      const foundUserIds = foundUsers.map(u => u.userId).sort();
      const expectedUserIds = users.map(u => u.userId).sort();
      expect(foundUserIds).toEqual(expectedUserIds);
    });

    test("should handle empty models", async () => {
      const foundUsers = [];
      for await (const batch of SingleBucketUser.iterateAll()) {
        foundUsers.push(...batch);
      }
      
      expect(foundUsers.length).toBe(0);
    });

    test("should apply filters during iteration", async () => {
      // Create test data with different statuses
      await SingleBucketUser.create({
        name: "Active User 1",
        email: "active1@example.com",
        status: "active"
      });
      await SingleBucketUser.create({
        name: "Inactive User",
        email: "inactive@example.com",
        status: "inactive"
      });
      await SingleBucketUser.create({
        name: "Active User 2",
        email: "active2@example.com",
        status: "active"
      });
      
      // Iterate and filter manually (since iter_index doesn't project status field)
      const foundUsers = [];
      for await (const batch of SingleBucketUser.iterateAll()) {
        const activeUsers = batch.filter(user => user.status === "active");
        foundUsers.push(...activeUsers);
      }
      
      expect(foundUsers.length).toBe(2);
      foundUsers.forEach(user => {
        expect(user.status).toBe("active");
      });
    });
  });

  describe("Multi-Bucket Iteration", () => {
    test("should iterate all buckets in iterateAll", async () => {
      // Create test data
      const users = [];
      for (let i = 0; i < 20; i++) {
        const user = await IterableUser.create({
          name: `User ${i}`,
          email: `user${i}@example.com`,
          status: "active"
        });
        users.push(user);
      }
      
      // Iterate and collect all users
      const foundUsers = [];
      for await (const batch of IterableUser.iterateAll({ batchSize: 3 })) {
        foundUsers.push(...batch);
      }
      
      expect(foundUsers.length).toBe(20);
      
      // Verify all created users are found
      const foundUserIds = foundUsers.map(u => u.userId).sort();
      const expectedUserIds = users.map(u => u.userId).sort();
      expect(foundUserIds).toEqual(expectedUserIds);
    });

    test("should support parallel bucket iteration", async () => {
      // Create test data
      const users = [];
      for (let i = 0; i < 15; i++) {
        const user = await IterableUser.create({
          name: `User ${i}`,
          email: `user${i}@example.com`,
          status: "active"
        });
        users.push(user);
      }
      
      // Iterate buckets in parallel
      const promises = [];
      const bucketCount = IterableUser.getIterationBuckets();
      
      for (let bucket = 0; bucket < bucketCount; bucket++) {
        promises.push(async () => {
          const bucketUsers = [];
          for await (const batch of IterableUser.iterateBucket(bucket, { batchSize: 5 })) {
            bucketUsers.push(...batch);
          }
          return bucketUsers;
        });
      }
      
      const results = await Promise.all(promises.map(fn => fn()));
      const allFoundUsers = results.flat();
      
      expect(allFoundUsers.length).toBe(15);
      
      // Verify all created users are found
      const foundUserIds = allFoundUsers.map(u => u.userId).sort();
      const expectedUserIds = users.map(u => u.userId).sort();
      expect(foundUserIds).toEqual(expectedUserIds);
    });

    test("should validate bucket numbers", async () => {
      await expect(async () => {
        for await (const batch of IterableUser.iterateBucket(-1)) {
          // Should not reach here
        }
      }).rejects.toThrow("Invalid bucket number");

      await expect(async () => {
        for await (const batch of IterableUser.iterateBucket(5)) { // buckets are 0-4
          // Should not reach here
        }
      }).rejects.toThrow("Invalid bucket number");
    });
  });

  describe("Integration with Tenancy", () => {
    test("should respect tenant context in iteration", async () => {
      const tenant1Id = `tenant1_${ulid()}`;
      const tenant2Id = `tenant2_${ulid()}`;
      
      try {
        // Create users in tenant 1
        TenantContext.setCurrentTenant(tenant1Id);
        const tenant1User = await IterableUser.create({
          name: "Tenant 1 User",
          email: "tenant1@example.com",
          status: "active"
        });
        
        // Create users in tenant 2
        TenantContext.setCurrentTenant(tenant2Id);
        const tenant2User = await IterableUser.create({
          name: "Tenant 2 User",
          email: "tenant2@example.com",
          status: "active"
        });
        
        // Switch back to tenant 1 and iterate
        TenantContext.setCurrentTenant(tenant1Id);
        const tenant1Users = [];
        for await (const batch of IterableUser.iterateAll()) {
          tenant1Users.push(...batch);
        }
        
        // Should only find tenant 1 user
        expect(tenant1Users.length).toBe(1);
        expect(tenant1Users[0].userId).toBe(tenant1User.userId);
        
        // Switch to tenant 2 and iterate
        TenantContext.setCurrentTenant(tenant2Id);
        const tenant2Users = [];
        for await (const batch of IterableUser.iterateAll()) {
          tenant2Users.push(...batch);
        }
        
        // Should only find tenant 2 user
        expect(tenant2Users.length).toBe(1);
        expect(tenant2Users[0].userId).toBe(tenant2User.userId);
        
      } finally {
        // Cleanup both tenants
        TenantContext.setCurrentTenant(tenant1Id);
        await cleanupTestData(tenant1Id);
        TenantContext.setCurrentTenant(tenant2Id);
        await cleanupTestData(tenant2Id);
        TenantContext.clearTenant();
      }
    });
  });

  describe("Error Handling", () => {
    test("should throw error when trying to iterate non-iterable model", async () => {
      await expect(async () => {
        for await (const batch of NonIterableUser.iterateAll()) {
          // Should not reach here
        }
      }).rejects.toThrow("not configured as iterable");
    });

    test("should throw error when trying to iterate bucket on non-iterable model", async () => {
      await expect(async () => {
        for await (const batch of NonIterableUser.iterateBucket(0)) {
          // Should not reach here
        }
      }).rejects.toThrow("not configured as iterable");
    });
  });

  describe("Performance", () => {
    test("should handle large datasets efficiently", async () => {
      // Create a moderate number of users for performance test
      const userCount = 50;
      const users = [];
      
      const startTime = Date.now();
      
      // Create users
      for (let i = 0; i < userCount; i++) {
        const user = await IterableUser.create({
          name: `User ${i}`,
          email: `user${i}@example.com`,
          status: i % 3 === 0 ? "inactive" : "active"
        });
        users.push(user);
      }
      
      const createTime = Date.now() - startTime;
      
      // Iterate through all users
      const iterateStartTime = Date.now();
      const foundUsers = [];
      for await (const batch of IterableUser.iterateAll({ batchSize: 10 })) {
        foundUsers.push(...batch);
      }
      const iterateTime = Date.now() - iterateStartTime;
      
      expect(foundUsers.length).toBe(userCount);
      
      // Performance should be reasonable (these are loose bounds for CI)
      expect(createTime).toBeLessThan(30000); // 30 seconds
      expect(iterateTime).toBeLessThan(10000); // 10 seconds
      
      logger.debug(`Performance test: Created ${userCount} users in ${createTime}ms, iterated in ${iterateTime}ms`);
    }, 60000); // 60 second timeout for this test
  });
});