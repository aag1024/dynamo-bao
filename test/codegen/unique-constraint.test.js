const dynamoBao = require("dynamo-bao");
const { TenantContext } = dynamoBao;
const testConfig = require("../config");
const { cleanupTestData, verifyCleanup, initTestModelsWithTenant } = require("../utils/test-utils");
const { ulid } = require("ulid");
const { User } = require("./generated/user");

let testId;

describe("Unique Constraint Lookups", () => {
  beforeEach(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    // Register models
    manager.registerModel(User);

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

  describe("User Model", () => {
    test("should find user by email", async () => {
      const createdUser = await User.create({
        name: "Test User",
        email: "findme@example.com",
      });

      const foundUser = await User.findByEmail("findme@example.com");
      expect(foundUser).toBeTruthy();
      expect(foundUser.userId).toBe(createdUser.userId);
      expect(foundUser.name).toBe("Test User");
      expect(foundUser.email).toBe("findme@example.com");

      // Test non-existent email
      const notFound = await User.findByEmail("doesnotexist@example.com");
      expect(notFound.exists()).toBe(false);
    });

    test("should handle null/undefined email lookup", async () => {
      await expect(async () => {
        await User.findByEmail(null);
      }).rejects.toThrow("email value is required");

      await expect(async () => {
        await User.findByEmail(undefined);
      }).rejects.toThrow("email value is required");
    });
  });
});
