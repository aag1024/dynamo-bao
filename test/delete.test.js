const dynamoBao = require("../src");
const { TenantContext } = dynamoBao;
const testConfig = require("./config");
const {
  BaoModel,
  PrimaryKeyConfig,
  UniqueConstraintConfig,
} = require("../src/model");
const { StringField, IntegerField } = require("../src/fields");
const { ConditionalError } = require("../src/exceptions");
const { cleanupTestData, verifyCleanup, initTestModelsWithTenant } = require("./utils/test-utils");
const { ulid } = require("ulid");
const { UNIQUE_CONSTRAINT_ID1 } = require("../src/constants");

let testId;

// Model without unique constraints - should use fast path
class SimpleUser extends BaoModel {
  static modelPrefix = "su";
  static fields = {
    userId: StringField({ required: true }),
    name: StringField({ required: true }),
    age: IntegerField(),
  };
  static primaryKey = PrimaryKeyConfig("userId");
}

// Model with unique constraints - should use transaction path
class UserWithUnique extends BaoModel {
  static modelPrefix = "uu";
  static fields = {
    userId: StringField({ required: true }),
    email: StringField({ required: true }),
    name: StringField({ required: true }),
  };
  static primaryKey = PrimaryKeyConfig("userId");
  static uniqueConstraints = {
    uniqueEmail: UniqueConstraintConfig("email", UNIQUE_CONSTRAINT_ID1),
  };
}

describe("Delete Operation Tests", () => {
  beforeEach(async () => {
    testId = ulid();
    const manager = initTestModelsWithTenant(testConfig, testId);
    manager.registerModel(SimpleUser);
    manager.registerModel(UserWithUnique);

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  describe("Fast Path (No Unique Constraints)", () => {
    let simpleUser;

    beforeEach(async () => {
      simpleUser = await SimpleUser.create({
        userId: "simple-user",
        name: "John Doe",
        age: 25,
      });
    });

    test("should delete item using fast path", async () => {
      const deleted = await SimpleUser.delete(simpleUser.userId);
      expect(deleted.exists()).toBe(true);

      const found = await SimpleUser.find(simpleUser.userId);
      expect(found.exists()).toBe(false);
    });

    test("should handle conditional delete in fast path", async () => {
      // Create a new user for this test
      const user = await SimpleUser.create({
        userId: "conditional-user",
        name: "John Doe",
        age: 25,
      });

      // This should succeed
      await expect(
        SimpleUser.delete(user.userId, {
          condition: { age: { $gt: 20 } },
        }),
      ).resolves.toBeDefined();

      // Create another user for the failing condition test
      const user2 = await SimpleUser.create({
        userId: "conditional-user-2",
        name: "John Doe",
        age: 25,
      });

      // This should fail
      await expect(
        SimpleUser.delete(user2.userId, {
          condition: { age: { $lt: 20 } },
        }),
      ).rejects.toThrow(ConditionalError);
    });
  });

  describe("Transaction Path (With Unique Constraints)", () => {
    test("should delete item and clean up unique constraints", async () => {
      const uniqueUser = await UserWithUnique.create({
        userId: "unique-user",
        email: "test@example.com",
        name: "Jane Doe",
      });

      const deleted = await UserWithUnique.delete(uniqueUser.userId);
      expect(deleted.exists()).toBe(true);

      const found = await UserWithUnique.find(uniqueUser.userId);
      expect(found.exists()).toBe(false);

      // Verify we can create another user with the same email
      await expect(
        UserWithUnique.create({
          userId: "another-user",
          email: "test@example.com",
          name: "Another User",
        }),
      ).resolves.toBeDefined();
    });

    test("should handle conditional delete in transaction path", async () => {
      // Create first user for successful condition
      const user1 = await UserWithUnique.create({
        userId: "unique-user-1",
        email: "test1@example.com",
        name: "Jane Doe",
      });

      await expect(
        UserWithUnique.delete(user1.userId, {
          condition: { name: "Jane Doe" },
        }),
      ).resolves.toBeDefined();

      // Create second user for failing condition
      const user2 = await UserWithUnique.create({
        userId: "unique-user-2",
        email: "test2@example.com",
        name: "Jane Doe",
      });

      await expect(
        UserWithUnique.delete(user2.userId, {
          condition: { name: "Wrong Name" },
        }),
      ).rejects.toThrow(ConditionalError);
    });
  });
});
