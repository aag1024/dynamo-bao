const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { defaultLogger: logger } = require("../src/utils/logger");

let testId;

class TestUser extends BaoModel {
  static modelPrefix = "tu";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    userId: StringField({ required: true }),
    firstName: StringField(),
    lastName: StringField(),
  };

  static primaryKey = PrimaryKeyConfig("userId");
}

// Example plugin with methods
const userPlugin = {
  model: "TestUser",
  methods: {
    getFullName() {
      return `${this.firstName} ${this.lastName}`;
    },
    setDefaultName() {
      this.firstName = "John";
      this.lastName = "Doe";
    },
  },
};

describe("Plugin Methods Tests", () => {
  let testUser;

  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();

      const manager = initTestModelsWithTenant(testConfig, testId);

      manager.registerModel(TestUser);
      TestUser.registerPlugin(userPlugin);

      if (testId) {
        await cleanupTestDataByIteration(testId, [TestUser]);
        await verifyCleanup(testId, [TestUser]);
      }

      // Create test user after model and plugin are fully registered
      testUser = await TestUser.create({
        userId: `test-user-${Date.now()}`,
        firstName: "Jane",
        lastName: "Smith",
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

  test("should add plugin methods to model instance", async () => {
    await runWithBatchContext(async () => {
      expect(typeof testUser.getFullName).toBe("function");
      expect(typeof testUser.setDefaultName).toBe("function");
    });
  });

  test("plugin methods should have access to instance data", async () => {
    await runWithBatchContext(async () => {
      const fullName = testUser.getFullName();
      expect(fullName).toBe("Jane Smith");
    });
  });

  test("plugin methods should be able to modify and save instance data", async () => {
    await runWithBatchContext(async () => {
      testUser.setDefaultName();
      await testUser.save();

      // Verify changes were saved
      const updatedUser = await TestUser.find(testUser.userId);
      expect(updatedUser.firstName).toBe("John");
      expect(updatedUser.lastName).toBe("Doe");
      expect(updatedUser.getFullName()).toBe("John Doe");
    });
  });

  test("should warn on method name conflicts", async () => {
    await runWithBatchContext(async () => {
      // Create a plugin with a conflicting method name
      const conflictingPlugin = {
        model: "TestUser",
        methods: {
          getFullName() {
            return "Conflict!";
          },
        },
      };

      // Spy on the logger instead of console
      const spy = jest.spyOn(logger, "warn").mockImplementation();

      TestUser.registerPlugin(conflictingPlugin);

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Method getFullName already exists for model TestUser",
        ),
      );

      spy.mockRestore();
    });
  });
});
