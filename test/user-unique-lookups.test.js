const dynamoBao = require("../src");
const { TenantContext } = dynamoBao;
const testConfig = require("./config");
const { cleanupTestData, verifyCleanup, initTestModelsWithTenant } = require("./utils/test-utils");
const { ulid } = require("ulid");
const { ValidationError } = require("../src/exceptions");

let User, testId;

describe("User Unique Constraint Lookups", () => {
  beforeEach(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    User = manager.getModel("User");
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  describe("Email Lookups", () => {
    test("should find user by email", async () => {
      const email = `test${Date.now()}@example.com`;
      const user = await User.create({
        name: "Test User",
        email: email,
        role: "user",
        status: "active",
      });

      const foundUser = await User.findByUniqueConstraint("uniqueEmail", email);
      expect(foundUser.userId).toBe(user.userId);
      expect(foundUser.email).toBe(email);
    });

    test("should return null for non-existent email", async () => {
      const foundUser = await User.findByUniqueConstraint(
        "uniqueEmail",
        "nonexistent@example.com",
      );
      expect(foundUser.exists()).toBe(false);
    });
  });

  describe("External ID Lookups", () => {
    test("should find user by external ID", async () => {
      const externalId = `ext${Date.now()}`;
      const user = await User.create({
        name: "Test User",
        email: `test${Date.now()}@example.com`,
        externalId: externalId,
        externalPlatform: "platform1",
        role: "user",
        status: "active",
      });

      const foundUser = await User.findByUniqueConstraint(
        "uniqueExternalId",
        externalId,
      );
      expect(foundUser.userId).toBe(user.userId);
      expect(foundUser.externalId).toBe(externalId);
    });

    test("should return null for non-existent external ID", async () => {
      const foundUser = await User.findByUniqueConstraint(
        "uniqueExternalId",
        "nonexistent-ext-id",
      );
      expect(foundUser.exists()).toBe(false);
    });
  });

  describe("Error Handling", () => {
    test("should throw error for invalid email format", async () => {
      await expect(
        User.findByUniqueConstraint("uniqueEmail", ""),
      ).rejects.toThrow(ValidationError);
    });

    test("should throw error for null external ID", async () => {
      await expect(
        User.findByUniqueConstraint("uniqueExternalId", null),
      ).rejects.toThrow(ValidationError);
    });
  });
});
