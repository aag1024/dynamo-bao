const dynamoBao = require("../src");
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, IntegerField, BooleanField } = require("../src/fields");
const { cleanupTestData, verifyCleanup } = require("./utils/test-utils");
const { ulid } = require("ulid");

let testId;

class TestUser extends BaoModel {
  static modelPrefix = "tu";

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
    testId = ulid();
    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });
    manager.registerModel(TestUser);

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
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

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test("should delete when condition is met", async () => {
    await expect(
      TestUser.delete(user.userId, {
        condition: {
          status: "active",
          age: { $gte: 20 },
        },
      }),
    ).resolves.toBeDefined();

    // Verify deletion
    const deletedUser = await TestUser.find(user.userId);
    expect(deletedUser.exists()).toBe(false);
  });

  test("should fail to delete when condition is not met", async () => {
    await expect(
      TestUser.delete(user.userId, {
        condition: {
          status: "inactive",
        },
      }),
    ).rejects.toThrow("Delete condition not met");

    // Verify item still exists
    const existingUser = await TestUser.find(user.userId);
    expect(existingUser.exists()).toBe(true);
  });

  test("should support complex conditions with $exists", async () => {
    await expect(
      TestUser.delete(user.userId, {
        condition: {
          $and: [{ status: { $exists: true } }, { age: { $gt: 20 } }],
        },
      }),
    ).resolves.toBeDefined();

    // Verify deletion
    const deletedUser = await TestUser.find(user.userId);
    expect(deletedUser.exists()).toBe(false);
  });

  test("should reject invalid field names in condition", async () => {
    await expect(
      TestUser.delete(user.userId, {
        condition: {
          invalidField: "value",
        },
      }),
    ).rejects.toThrow("Unknown field in filter: invalidField");
  });
});
