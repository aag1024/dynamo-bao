const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  BaoModel,
  PrimaryKeyConfig,
  UniqueConstraintConfig,
} = require("../src/model");
const { StringField } = require("../src/fields");
const { ConditionalError } = require("../src/exceptions");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { UNIQUE_CONSTRAINT_ID1 } = require("../src/constants");

let testId;

// Iterable composite-key model with a unique constraint, so an update by
// object id exercises the iteration keys and the constraint rows.
class AppEntity extends BaoModel {
  static modelPrefix = "ape";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    appId: StringField({ required: true }),
    entityId: StringField({ required: true }),
    slug: StringField(),
    label: StringField(),
  };
  static primaryKey = PrimaryKeyConfig("appId", "entityId");
  static uniqueConstraints = {
    uniqueSlug: UniqueConstraintConfig("slug", UNIQUE_CONSTRAINT_ID1),
  };
}

describe("Object primary ids", () => {
  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();
      const manager = initTestModelsWithTenant(testConfig, testId);
      manager.registerModel(AppEntity);
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [AppEntity]);
        await verifyCleanup(testId, [AppEntity]);
      }
    });
  });

  test("update by object id on an iterable model", async () => {
    await runWithBatchContext(async () => {
      const entity = await AppEntity.create({
        appId: "app",
        entityId: "e1",
        label: "v1",
      });

      const updated = await AppEntity.update(
        { appId: "app", entityId: "e1" },
        { label: "v2" },
      );
      expect(updated.label).toBe("v2");

      const stored = await AppEntity.find(entity.getPrimaryId(), {
        batchDelay: 0,
        bypassCache: true,
      });
      expect(stored.label).toBe("v2");
      expect(stored._dyData._iter_sk).toBe(entity._dyData._iter_sk);
    });
  });

  test("update of a unique field by object id stores the string id on the constraint", async () => {
    await runWithBatchContext(async () => {
      const entity = await AppEntity.create({ appId: "app", entityId: "e1" });

      await AppEntity.update(
        { appId: "app", entityId: "e1" },
        { slug: "taken" },
      );

      const owner = await AppEntity.findByUniqueConstraint(
        "uniqueSlug",
        "taken",
      );
      expect(owner.getPrimaryId()).toBe(entity.getPrimaryId());

      // The owner can re-save its own value by either id form...
      await AppEntity.update(entity.getPrimaryId(), {
        slug: "taken",
        label: "again",
      });
      // ...and nobody else can take it.
      await AppEntity.create({ appId: "app", entityId: "e2" });
      await expect(
        AppEntity.update({ appId: "app", entityId: "e2" }, { slug: "taken" }),
      ).rejects.toThrow(ConditionalError);
    });
  });
});
