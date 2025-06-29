const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { ModelManager } = require("../src/model-manager");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, VersionField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { defaultLogger: logger } = require("../src/utils/logger");
const { ConditionalError } = require("../src/exceptions");

let testId;

class TestVersion extends BaoModel {
  static modelPrefix = "tv";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    id: StringField({ required: true }),
    name: StringField(),
    version: VersionField(),
    unchangedField: StringField(),
  };

  static primaryKey = PrimaryKeyConfig("id");
}

describe("Version Field Tests", () => {
  let testVersion;

  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();

      dynamoBao.initModels({
        ...testConfig,
        testId: testId,
      });

      // Register the TestVersion model
      const manager = ModelManager.getInstance(testId);
      manager.registerModel(TestVersion);

      await cleanupTestDataByIteration(testId, [TestVersion]);
      await verifyCleanup(testId, [TestVersion]);

      // Create a new version test item for each test
      testVersion = await TestVersion.create({
        id: `test-version-${Date.now()}`,
        name: "Initial Name",
        unchangedField: "static value",
      });
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [TestVersion]);
        await verifyCleanup(testId, [TestVersion]);
      }
    });
  });

  test("should initialize with a ULID version", async () => {
    await runWithBatchContext(async () => {
      expect(testVersion.version).toBeDefined();
      expect(typeof testVersion.version).toBe("string");
      expect(testVersion.version.length).toBe(26); // ULID length
    });
  });

  test("should update version on field changes", async () => {
    await runWithBatchContext(async () => {
      const originalVersion = testVersion.version;
      const updated = await TestVersion.update(testVersion.id, {
        name: "Updated Name",
      });

      expect(updated.version).toBeDefined();
      expect(updated.version).not.toBe(originalVersion);
      expect(updated.version > originalVersion).toBe(true); // ULIDs are chronologically sortable
    });
  });

  test("should not update version when no fields change", async () => {
    await runWithBatchContext(async () => {
      const client1 = await TestVersion.find(testVersion.id);
      expect(client1.version).toBe(testVersion.version);

      client1.name = "Initial Name";
      await client1.save();
      expect(client1.version).toBe(testVersion.version);

      client1.name = "Client 1 New Name";
      await client1.save();
      expect(client1.version).not.toBe(testVersion.version);
    });
  });

  test("should enforce version constraint in concurrent updates", async () => {
    let client1, client2;

    await runWithBatchContext(async () => {
      // First client loads the item as instance
      client1 = await TestVersion.find(testVersion.id);
      expect(client1.version).toBe(testVersion.version);
    });

    await runWithBatchContext(async () => {
      // Second client loads the item as instance in separate context
      client2 = await TestVersion.find(testVersion.id);
      expect(client2.version).toBe(testVersion.version);
    });

    await runWithBatchContext(async () => {
      // First client updates successfully
      client1.name = "Client 1 Update";
      await client1.save({
        condition: { version: client1.version },
      });

      logger.log("VERSIONS", client1.version, testVersion.version);
      expect(client1.version).not.toBe(testVersion.version);
    });

    await runWithBatchContext(async () => {
      // Second client tries to update with old version
      client2.name = "Client 2 Update";
      await expect(
        client2.save({
          condition: { version: client2.version },
        }),
      ).rejects.toThrow(ConditionalError);
    });
  });

  test("should maintain version through instance updates", async () => {
    await runWithBatchContext(async () => {
      const instance = await TestVersion.find(testVersion.id);
      const originalVersion = instance.version;

      instance.name = "First Update";
      await instance.save();
      const firstVersion = instance.version;
      expect(firstVersion).not.toBe(originalVersion);
      expect(firstVersion > originalVersion).toBe(true);

      instance.name = "Second Update";
      await instance.save();
      const secondVersion = instance.version;
      expect(secondVersion).not.toBe(firstVersion);
      expect(secondVersion > firstVersion).toBe(true);
    });
  });

  test("should not update version on reads", async () => {
    await runWithBatchContext(async () => {
      const originalVersion = testVersion.version;

      await TestVersion.find(testVersion.id);
      await TestVersion.find(testVersion.id);

      const reloaded = await TestVersion.find(testVersion.id);
      expect(reloaded.version).toBe(originalVersion);
    });
  });

  test("should handle multiple field updates with single version update", async () => {
    await runWithBatchContext(async () => {
      const originalVersion = testVersion.version;

      const updated = await TestVersion.update(testVersion.id, {
        name: "New Name",
        unchangedField: "new value",
      });

      expect(updated.version).not.toBe(originalVersion);
      expect(updated.version > originalVersion).toBe(true);

      // Verify only one version change occurred
      const history = [originalVersion, updated.version];
      expect(new Set(history).size).toBe(2); // Should only have two distinct versions
    });
  });
});
