const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, IntegerField, BooleanField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { ConditionalError, QueryError } = require("../src/exceptions");

let testId;

class TestUser extends BaoModel {
  static modelPrefix = "tu";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    userId: StringField({ required: true }),
    name: StringField({ required: true }),
    age: IntegerField(),
    status: StringField(),
    isVerified: BooleanField({ defaultValue: false }),
  };

  static primaryKey = PrimaryKeyConfig("userId");
}

describe("Conditional Delete Tests", () => {
  let user;

  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();
      const manager = initTestModelsWithTenant(testConfig, testId);
      manager.registerModel(TestUser);

      if (testId) {
        await cleanupTestDataByIteration(testId, [TestUser]);
        await verifyCleanup(testId, [TestUser]);
      }

      // Create test user
      user = await TestUser.create({
        userId: "test-user",
        name: "John Doe",
        age: 25,
        status: "active",
        isVerified: true,
      });
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [TestUser]);
        await verifyCleanup(testId, [TestUser]);
      }
    });
  });

  test("should delete when condition is met", async () => {
    let userId;

    await runWithBatchContext(async () => {
      userId = user.userId;
      await expect(
        TestUser.delete(user.userId, {
          condition: {
            status: "active",
            age: { $gte: 20 },
          },
        }),
      ).resolves.toBeDefined();
    });

    // Use separate batch context to verify deletion
    await runWithBatchContext(async () => {
      const deletedUser = await TestUser.find(userId);
      expect(deletedUser.exists()).toBe(false);
    });
  });

  test("should fail to delete when condition is not met", async () => {
    await runWithBatchContext(async () => {
      await expect(
        TestUser.delete(user.userId, {
          condition: {
            status: "inactive",
          },
        }),
      ).rejects.toThrow(ConditionalError);

      // Verify item still exists
      const existingUser = await TestUser.find(user.userId);
      expect(existingUser.exists()).toBe(true);
    });
  });

  test("should support complex conditions with $exists", async () => {
    let userId;

    await runWithBatchContext(async () => {
      userId = user.userId;
      await expect(
        TestUser.delete(user.userId, {
          condition: {
            $and: [{ status: { $exists: true } }, { age: { $gt: 20 } }],
          },
        }),
      ).resolves.toBeDefined();
    });

    // Use separate batch context to verify deletion
    await runWithBatchContext(async () => {
      const deletedUser = await TestUser.find(userId);
      expect(deletedUser.exists()).toBe(false);
    });
  });

  test("should support $or conditions", async () => {
    let userId;

    await runWithBatchContext(async () => {
      userId = user.userId;
      // Test successful delete with $or where one condition matches
      await expect(
        TestUser.delete(user.userId, {
          condition: {
            $or: [{ status: "inactive" }, { age: { $gte: 25 } }],
          },
        }),
      ).resolves.toBeDefined();
    });

    // Use separate batch context to verify deletion
    await runWithBatchContext(async () => {
      const deletedUser = await TestUser.find(userId);
      expect(deletedUser.exists()).toBe(false);
    });
  });

  test("should fail $or conditions when no condition matches", async () => {
    await runWithBatchContext(async () => {
      await expect(
        TestUser.delete(user.userId, {
          condition: {
            $or: [{ status: "inactive" }, { age: { $lt: 20 } }],
          },
        }),
      ).rejects.toThrow(ConditionalError);

      // Verify item still exists
      const existingUser = await TestUser.find(user.userId);
      expect(existingUser.exists()).toBe(true);
    });
  });

  test("should reject invalid field names in condition", async () => {
    await runWithBatchContext(async () => {
      await expect(
        TestUser.delete(user.userId, {
          condition: {
            invalidField: "value",
          },
        }),
      ).rejects.toThrow(QueryError);
    });
  });
});
