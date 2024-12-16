const dynamoBao = require("../src");
const testConfig = require("./config");
const { ModelManager } = require("../src/model-manager");
const { BaseModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, VersionField } = require("../src/fields");
const { cleanupTestData, verifyCleanup } = require("./utils/test-utils");
const { ulid } = require("ulid");
const { defaultLogger: logger } = require("../src/utils/logger");

let testId;

class TestVersion extends BaseModel {
  static modelPrefix = "tv";

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
    testId = ulid();

    dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    // Register the TestVersion model
    const manager = ModelManager.getInstance(testId);
    manager.registerModel(TestVersion);

    // Create a new version test item for each test
    testVersion = await TestVersion.create({
      id: `test-version-${Date.now()}`,
      name: "Initial Name",
      unchangedField: "static value",
    });
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test("should initialize with a ULID version", async () => {
    expect(testVersion.version).toBeDefined();
    expect(typeof testVersion.version).toBe("string");
    expect(testVersion.version.length).toBe(26); // ULID length
  });

  test("should update version on field changes", async () => {
    const originalVersion = testVersion.version;
    const updated = await TestVersion.update(testVersion.id, {
      name: "Updated Name",
    });

    expect(updated.version).toBeDefined();
    expect(updated.version).not.toBe(originalVersion);
    expect(updated.version > originalVersion).toBe(true); // ULIDs are chronologically sortable
  });

  test("should not update version when no fields change", async () => {
    const client1 = await TestVersion.find(testVersion.id);
    expect(client1.version).toBe(testVersion.version);

    client1.name = "Initial Name";
    await client1.save();
    expect(client1.version).toBe(testVersion.version);

    client1.name = "Client 1 New Name";
    await client1.save();
    expect(client1.version).not.toBe(testVersion.version);
  });

  test("should enforce version constraint in concurrent updates", async () => {
    // First client loads the item as instance
    const client1 = await TestVersion.find(testVersion.id);
    expect(client1.version).toBe(testVersion.version);

    // Second client loads the item as instance
    const client2 = await TestVersion.find(testVersion.id);
    expect(client1.version).toBe(testVersion.version);

    // First client updates successfully
    client1.name = "Client 1 Update";
    await client1.save({ constraints: { fieldMatches: "version" } });

    logger.log("VERSIONS", client1.version, testVersion.version);
    expect(client1.version).not.toBe(testVersion.version);

    // Second client tries to update with old version
    client2.name = "Client 2 Update";
    await expect(
      client2.save({
        constraints: { fieldMatches: "version" },
      }),
    ).rejects.toThrow("Field values have been modified");
  });

  test("should maintain version through instance updates", async () => {
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

  test("should not update version on reads", async () => {
    const originalVersion = testVersion.version;

    await TestVersion.find(testVersion.id);
    await TestVersion.find(testVersion.id);

    const reloaded = await TestVersion.find(testVersion.id);
    expect(reloaded.version).toBe(originalVersion);
  });

  test("should handle multiple field updates with single version update", async () => {
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
