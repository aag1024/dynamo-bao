const dynamoBao = require("../src");
const testConfig = require("./config");
const { cleanupTestData, verifyCleanup } = require("./utils/test-utils");
const { ulid } = require("ulid");
const { defaultLogger: logger } = require("../src/utils/logger");
const {
  BaoModel,
  PrimaryKeyConfig,
  UniqueConstraintConfig,
} = require("../src/model");
const { StringField, IntegerField } = require("../src/fields");
const { ConditionalError } = require("../src/exceptions");

let testId;

beforeEach(async () => {
  testId = ulid();

  const manager = dynamoBao.initModels({
    ...testConfig,
    testId: testId,
  });

  await cleanupTestData(testId);
  await verifyCleanup(testId);

  User = manager.getModel("User");
});

afterEach(async () => {
  if (testId) {
    await cleanupTestData(testId);
    await verifyCleanup(testId);
  }
});

describe("User Unique Constraints", () => {
  test("should create user with unique email", async () => {
    const userData = {
      name: "Test User 1",
      email: "test1@example.com",
    };
    const user = await User.create(userData);
    expect(user.name).toBe(userData.name);
    expect(user.email).toBe(userData.email);
  });

  test("should prevent duplicate email creation", async () => {
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

  test("should allow creating user with different email", async () => {
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

  test("should allow updating user with unique email", async () => {
    const user = await User.create({
      name: "Test User 1",
      email: "test1@example.com",
      status: "active",
    });

    const updatedUser = await User.update(user.userId, {
      email: "test2@example.com",
      status: user.status,
      createdAt: user.createdAt,
    });

    logger.log("updatedUser", updatedUser);

    expect(updatedUser.email).toBe("test2@example.com");

    const user2 = await User.create({
      name: "Test User 1",
      email: "test1@example.com",
      status: "active",
    });
    expect(user2.email).toBe("test1@example.com");
  });

  test("should prevent updating user with existing email", async () => {
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

  test("should allow reusing email after user deletion", async () => {
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
