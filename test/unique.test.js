const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { defaultLogger: logger } = require("../src/utils/logger");
const {
  BaoModel,
  PrimaryKeyConfig,
  UniqueConstraintConfig,
} = require("../src/model");
const { StringField, IntegerField } = require("../src/fields");
const { ConditionalError } = require("../src/exceptions");

let testId, User;

beforeEach(async () => {
  await runWithBatchContext(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    User = manager.getModel("User");
  });
});

afterEach(async () => {
  await runWithBatchContext(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [User]);
      await verifyCleanup(testId, [User]);
    }
  });
});

describe("User Unique Constraints", () => {
  test("should create user with unique email", async () => {
    await runWithBatchContext(async () => {
      const userData = {
        name: "Test User 1",
        email: "test1@example.com",
      };
      const user = await User.create(userData);
      expect(user.name).toBe(userData.name);
      expect(user.email).toBe(userData.email);
    });
  });

  test("should prevent duplicate email creation", async () => {
    await runWithBatchContext(async () => {
      const userData = {
        name: "Test User 1",
        email: "test1@example.com",
      };
      await User.create(userData);

      await expect(async () => {
        await User.create({
          name: "Test User 2",
          email: "test1@example.com",
        });
      }).rejects.toThrow(ConditionalError);
    });
  });

  test("should allow creating user with different email", async () => {
    await runWithBatchContext(async () => {
      const user2Data = {
        name: "Test User 2",
        email: "test2@example.com",
        role: "user",
        status: "active",
        createdAt: new Date(),
        modifiedAt: new Date(),
      };
      const user2 = await User.create(user2Data);

      // Only check the fields we care about
      expect(user2).toMatchObject({
        name: user2Data.name,
        email: user2Data.email,
        role: user2Data.role,
        status: user2Data.status,
      });

      // Verify timestamps exist but don't check exact values
      expect(user2.createdAt).toBeInstanceOf(Date);
      expect(user2.modifiedAt).toBeInstanceOf(Date);

      // Verify ID was generated
      expect(user2.userId).toBeDefined();
    });
  });

  test("should allow updating user with unique email", async () => {
    let user;

    await runWithBatchContext(async () => {
      user = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
        status: "active",
      });
    });

    await runWithBatchContext(async () => {
      await User.update(user.userId, {
        email: "test2@example.com",
        status: user.status,
        createdAt: user.createdAt,
      });
    });

    await runWithBatchContext(async () => {
      // Verify the update was persisted
      const updatedUser = await User.find(user.userId);
      expect(updatedUser.email).toBe("test2@example.com");

      const user2 = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
        status: "active",
      });
      expect(user2.email).toBe("test1@example.com");
    });
  });

  test("should prevent updating user with existing email", async () => {
    await runWithBatchContext(async () => {
      const user1 = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
        status: "active",
      });

      await User.create({
        name: "Test User 2",
        email: "test2@example.com",
        status: "active",
      });

      await expect(async () => {
        await User.update(user1.userId, {
          email: "test2@example.com",
          status: user1.status,
          createdAt: user1.createdAt,
        });
      }).rejects.toThrow(ConditionalError);
    });
  });

  test("should allow reusing email after user deletion", async () => {
    await runWithBatchContext(async () => {
      const user1 = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
      });

      await User.delete(user1.userId);

      const user2 = await User.create({
        name: "Test User 2",
        email: "test1@example.com",
      });
      expect(user2.email).toBe("test1@example.com");
    });
  });
});
