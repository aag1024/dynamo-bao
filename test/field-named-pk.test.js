const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, UlidField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

let testId;

// A user field literally named `pk` gets the "#pk" placeholder in the update
// expression, so the create guard must not reuse that name for `_pk`.
class FieldNamedPk extends BaoModel {
  static modelPrefix = "fnp";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    itemId: UlidField({ autoAssign: true }),
    pk: StringField(),
  };
  static primaryKey = PrimaryKeyConfig("itemId");
}

describe("Field named pk", () => {
  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();
      const manager = initTestModelsWithTenant(testConfig, testId);
      manager.registerModel(FieldNamedPk);
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [FieldNamedPk]);
        await verifyCleanup(testId, [FieldNamedPk]);
      }
    });
  });

  test("create stores the field", async () => {
    await runWithBatchContext(async () => {
      const item = await FieldNamedPk.create({ pk: "some-value" });
      expect(item.pk).toBe("some-value");

      const stored = await FieldNamedPk.find(item.itemId, {
        batchDelay: 0,
        bypassCache: true,
      });
      expect(stored.pk).toBe("some-value");
    });
  });

  test("create guard still rejects an existing item", async () => {
    await runWithBatchContext(async () => {
      const item = await FieldNamedPk.create({ pk: "first" });
      await expect(
        FieldNamedPk.create({ itemId: item.itemId, pk: "second" }),
      ).rejects.toThrow("Condition check failed");
    });
  });
});
