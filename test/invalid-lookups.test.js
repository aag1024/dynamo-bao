const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  BaoModel,
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
} = require("../src/model");

const { GSI_INDEX_ID1, UNIQUE_CONSTRAINT_ID1 } = require("../src/constants");

const { StringField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

let testId;

class TestModel extends BaoModel {
  static modelPrefix = "tm";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    itemId: StringField({ required: true }),
    name: StringField(),
  };

  static primaryKey = PrimaryKeyConfig("itemId");

  // Add index and unique constraint configurations
  static indexes = {
    byName: IndexConfig("name", "modelPrefix", GSI_INDEX_ID1),
  };

  static uniqueConstraints = {
    uniqueName: UniqueConstraintConfig("name", UNIQUE_CONSTRAINT_ID1),
  };
}

describe("Invalid Lookup Tests", () => {
  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();

      const manager = initTestModelsWithTenant(testConfig, testId);

      manager.registerModel(TestModel);

      if (testId) {
        await cleanupTestDataByIteration(testId, [TestModel]);
        await verifyCleanup(testId, [TestModel]);
      }
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [TestModel]);
        await verifyCleanup(testId, [TestModel]);
      }
    });
  });

  test("should return null when primary key does not exist", async () => {
    await runWithBatchContext(async () => {
      const result = await TestModel.find("non-existent-id");
      expect(result.exists()).toBe(false);
    });
  });

  test("should return null when sort key does not exist", async () => {
    await runWithBatchContext(async () => {
      const nonExistentId = `test-item-${Date.now()}##__SK__##wrong-sk`;
      const result = await TestModel.find(nonExistentId);
      expect(result.exists()).toBe(false);
    });
  });

  test("should return null when unique constraint lookup fails", async () => {
    await runWithBatchContext(async () => {
      const result = await TestModel.findByUniqueConstraint(
        "uniqueName",
        "non-existent-name",
      );
      expect(result.exists()).toBe(false);
    });
  });

  test("should return empty array when querying non-existent index value", async () => {
    await runWithBatchContext(async () => {
      const result = await TestModel.queryByIndex(
        "byName",
        "non-existent-name",
      );
      expect(result.items).toEqual([]);
      expect(result.count).toBe(0);
    });
  });
});
