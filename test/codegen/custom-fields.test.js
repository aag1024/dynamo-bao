const dynamoBao = require("../../src");
const testConfig = require("../config");
const { cleanupTestData, verifyCleanup } = require("../utils/test-utils");
const { ulid } = require("ulid");
const { UserWithEmail } = require("./generated/user-with-email");

let testId;

describe("Custom Fields", () => {
  beforeEach(async () => {
    testId = ulid();

    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });

    // Register the model
    manager.registerModel(UserWithEmail);

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

  describe("Email Field", () => {
    test("should create user with valid company email", async () => {
      const user = await UserWithEmail.create({
        name: "Test User",
        email: "test@company.com",
      });

      expect(user.email).toBe("test@company.com");

      // Verify persistence
      const fetchedUser = await UserWithEmail.find(user.userId);
      expect(fetchedUser.email).toBe("test@company.com");
    });

    test("should create user with valid subsidiary email", async () => {
      const user = await UserWithEmail.create({
        name: "Test User",
        email: "test@subsidiary.com",
      });

      expect(user.email).toBe("test@subsidiary.com");
    });

    test("should reject email from unauthorized domain", async () => {
      await expect(async () => {
        await UserWithEmail.create({
          name: "Invalid User",
          email: "test@gmail.com",
        });
      }).rejects.toThrow(
        "Email domain must be one of: company.com, subsidiary.com",
      );
    });

    test("should reject invalid email format", async () => {
      await expect(async () => {
        await UserWithEmail.create({
          name: "Invalid User",
          email: "not-an-email",
        });
      }).rejects.toThrow("Invalid email format");
    });

    test("should allow updating to valid company email", async () => {
      const user = await UserWithEmail.create({
        name: "Test User",
        email: "test@company.com",
      });

      const updatedUser = await UserWithEmail.update(user.userId, {
        email: "new@subsidiary.com",
      });

      expect(updatedUser.email).toBe("new@subsidiary.com");
    });

    test("should reject update with unauthorized domain", async () => {
      const user = await UserWithEmail.create({
        name: "Test User",
        email: "test@company.com",
      });

      await expect(async () => {
        await UserWithEmail.update(user.userId, {
          email: "test@gmail.com",
        });
      }).rejects.toThrow(
        "Email domain must be one of: company.com, subsidiary.com",
      );
    });

    test("should reject update with invalid email format", async () => {
      const user = await UserWithEmail.create({
        name: "Test User",
        email: "test@company.com",
      });

      await expect(async () => {
        await UserWithEmail.update(user.userId, {
          email: "invalid-email",
        });
      }).rejects.toThrow("Invalid email format");
    });
  });
});
