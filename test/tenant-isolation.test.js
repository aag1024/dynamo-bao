const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  BaoModel,
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
} = require("../src/model");
const { StringField, UlidField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { GSI_INDEX_ID1, UNIQUE_CONSTRAINT_ID1 } = require("../src/constants");

let testId1, testId2;

class TestUser extends BaoModel {
  static modelPrefix = "tu";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    userId: UlidField({ required: true, autoAssign: true }),
    name: StringField({ required: true }),
    email: StringField({ required: true }),
    status: StringField({ required: true }),
  };

  static primaryKey = PrimaryKeyConfig("userId");

  static indexes = {
    byStatus: IndexConfig("status", "userId", GSI_INDEX_ID1),
  };

  static uniqueConstraints = {
    uniqueEmail: UniqueConstraintConfig("email", UNIQUE_CONSTRAINT_ID1),
  };
}

describe("Tenant Isolation Tests", () => {
  beforeEach(async () => {
    // Create two different tenant IDs
    testId1 = ulid();
    testId2 = ulid();

    // Initialize models for both tenants
    const manager1 = initTestModelsWithTenant(testConfig, testId1);
    const manager2 = initTestModelsWithTenant(testConfig, testId2);

    manager1.registerModel(TestUser);
    manager2.registerModel(TestUser);

    // Clean up any existing data
    await runWithBatchContext(async () => {
      await cleanupTestDataByIteration(testId1, [TestUser]);
      await cleanupTestDataByIteration(testId2, [TestUser]);
      await verifyCleanup(testId1, [TestUser]);
      await verifyCleanup(testId2, [TestUser]);
    });
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId1) {
      await runWithBatchContext(async () => {
        await cleanupTestDataByIteration(testId1, [TestUser]);
        await verifyCleanup(testId1, [TestUser]);
      });
    }
    if (testId2) {
      await runWithBatchContext(async () => {
        await cleanupTestDataByIteration(testId2, [TestUser]);
        await verifyCleanup(testId2, [TestUser]);
      });
    }
  });

  describe("GSI Tenant Isolation", () => {
    test("should only return results from current tenant when querying GSI", async () => {
      await runWithBatchContext(async () => {
        // Create users in tenant 1
        await TenantContext.runWithTenant(testId1, async () => {
          await TestUser.create({
            name: "User 1",
            email: "user1@example.com",
            status: "active",
          });
          await TestUser.create({
            name: "User 2",
            email: "user2@example.com",
            status: "active",
          });
        });

        // Create users in tenant 2
        await TenantContext.runWithTenant(testId2, async () => {
          await TestUser.create({
            name: "User 3",
            email: "user3@example.com",
            status: "active",
          });
        });

        // Query from tenant 1 context
        await TenantContext.runWithTenant(testId1, async () => {
          const results = await TestUser.queryByIndex("byStatus", "active");
          expect(results.items).toHaveLength(2);
          expect(results.items.map((u) => u.email).sort()).toEqual([
            "user1@example.com",
            "user2@example.com",
          ]);
        });

        // Query from tenant 2 context
        await TenantContext.runWithTenant(testId2, async () => {
          const results = await TestUser.queryByIndex("byStatus", "active");
          expect(results.items).toHaveLength(1);
          expect(results.items[0].email).toBe("user3@example.com");
        });
      });
    });
  });

  describe("Unique Constraint Tenant Isolation", () => {
    test("should allow same unique value in different tenants", async () => {
      await runWithBatchContext(async () => {
        const sharedEmail = "shared@example.com";

        // Create user with email in tenant 1
        await TenantContext.runWithTenant(testId1, async () => {
          const user1 = await TestUser.create({
            name: "User 1",
            email: sharedEmail,
            status: "active",
          });
          expect(user1.email).toBe(sharedEmail);
        });

        // Create user with same email in tenant 2
        await TenantContext.runWithTenant(testId2, async () => {
          const user2 = await TestUser.create({
            name: "User 2",
            email: sharedEmail,
            status: "active",
          });
          expect(user2.email).toBe(sharedEmail);
        });

        // Verify both users exist in their respective tenants
        await TenantContext.runWithTenant(testId1, async () => {
          const foundUser = await TestUser.findByUniqueConstraint(
            "uniqueEmail",
            sharedEmail,
          );
          expect(foundUser.exists()).toBe(true);
          expect(foundUser.email).toBe(sharedEmail);
        });

        await TenantContext.runWithTenant(testId2, async () => {
          const foundUser = await TestUser.findByUniqueConstraint(
            "uniqueEmail",
            sharedEmail,
          );
          expect(foundUser.exists()).toBe(true);
          expect(foundUser.email).toBe(sharedEmail);
        });
      });
    });

    test("should not find unique constraint across tenants", async () => {
      await runWithBatchContext(async () => {
        const email = "test@example.com";

        // Create user in tenant 1
        await TenantContext.runWithTenant(testId1, async () => {
          await TestUser.create({
            name: "User 1",
            email: email,
            status: "active",
          });
        });

        // Try to find user from tenant 2 context
        await TenantContext.runWithTenant(testId2, async () => {
          const foundUser = await TestUser.findByUniqueConstraint(
            "uniqueEmail",
            email,
          );
          expect(foundUser.exists()).toBe(false);
        });
      });
    });
  });

  describe("Cross-Tenant Operations", () => {
    test("should maintain tenant isolation during cross-tenant operations", async () => {
      await runWithBatchContext(async () => {
        // Create users in both tenants
        await TenantContext.runWithTenant(testId1, async () => {
          await TestUser.create({
            name: "User 1",
            email: "user1@example.com",
            status: "active",
          });
        });

        await TenantContext.runWithTenant(testId2, async () => {
          await TestUser.create({
            name: "User 2",
            email: "user2@example.com",
            status: "active",
          });
        });

        // Perform cross-tenant operations
        const results = await Promise.all([
          TenantContext.withTenant(testId1, async () => {
            const users = await TestUser.queryByIndex("byStatus", "active");
            return users.items.map((u) => u.email);
          }),
          TenantContext.withTenant(testId2, async () => {
            const users = await TestUser.queryByIndex("byStatus", "active");
            return users.items.map((u) => u.email);
          }),
        ]);

        // Verify results are isolated
        expect(results[0]).toEqual(["user1@example.com"]);
        expect(results[1]).toEqual(["user2@example.com"]);
      });
    });
  });
});
