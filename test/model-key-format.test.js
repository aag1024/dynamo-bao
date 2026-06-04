const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField } = require("../src/fields");
const { ModelManager } = require("../src/model-manager");
const { TenantContext } = require("../src/tenant-context");

class ModelPrefixPartitionItem extends BaoModel {
  static modelPrefix = "mppi";

  static fields = {
    name: StringField({ required: true }),
  };

  static primaryKey = PrimaryKeyConfig("modelPrefix", "name");
}

// A composite-key model (neither pk nor sk is modelPrefix) to confirm the
// migration mode does not affect other key shapes.
class CompositeItem extends BaoModel {
  static modelPrefix = "comp";

  static fields = {
    owner: StringField({ required: true }),
    name: StringField({ required: true }),
  };

  static primaryKey = PrimaryKeyConfig("owner", "name");
}

const pkSk = { pk: ModelPrefixPartitionItem.modelPrefix, sk: "shared-name" };

function registerUnderTenant(tenant) {
  ModelManager.getInstance(tenant).registerModel(ModelPrefixPartitionItem);
  ModelManager.getInstance(tenant).registerModel(CompositeItem);
}

function setMode(mode) {
  ModelPrefixPartitionItem._config = {
    keyMigration: { modelPrefixPkMode: mode },
  };
  CompositeItem._config = { keyMigration: { modelPrefixPkMode: mode } };
}

describe("Model key formatting — pk === modelPrefix migration modes", () => {
  afterEach(() => {
    delete ModelPrefixPartitionItem._config;
    delete CompositeItem._config;
    TenantContext.clearTenant();
    TenantContext.reset();
  });

  test("legacy mode (default) uses the bare global modelPrefix partition key", () => {
    const tenant = "tenant-one";
    registerUnderTenant(tenant);
    // No keyMigration config => defaults to "legacy".
    expect(ModelPrefixPartitionItem._modelPrefixPkMode()).toBe("legacy");
    expect(ModelPrefixPartitionItem._getDyKeyForPkSk(pkSk)).toEqual({
      _pk: "mppi",
      _sk: "shared-name",
    });
    // No read fallback in legacy mode.
    expect(ModelPrefixPartitionItem._legacyDyKeysForPkSk(pkSk)).toEqual([]);
  });

  test("tenant-scoped mode uses the clean [tenant]#prefix partition key", () => {
    const tenant = "tenant-one";
    registerUnderTenant(tenant);
    setMode("tenant-scoped");
    expect(ModelPrefixPartitionItem._getDyKeyForPkSk(pkSk)).toEqual({
      _pk: `[${tenant}]#mppi`,
      _sk: "shared-name",
    });
    // Fallback is off once migration has completed.
    expect(ModelPrefixPartitionItem._legacyDyKeysForPkSk(pkSk)).toEqual([]);
  });

  test("write key matches the query partition (write/query consistency) in every mode", () => {
    const tenant = "tenant-one";
    registerUnderTenant(tenant);
    for (const mode of ["legacy", "migrating", "tenant-scoped"]) {
      setMode(mode);
      // The canonical write _pk must equal what the query path computes for a
      // primary-key query (value === modelPrefix). This is the P1a invariant.
      expect(ModelPrefixPartitionItem._getDyKeyForPkSk(pkSk)._pk).toBe(
        ModelPrefixPartitionItem._formatPrimaryPartition(
          ModelPrefixPartitionItem.modelPrefix,
        ),
      );
    }
  });

  test("migrating mode: clean canonical key + fallback to BOTH legacy shapes", () => {
    const tenant = "tenant-one";
    registerUnderTenant(tenant);
    setMode("migrating");

    // Canonical (write/primary-read) key is the clean tenant-scoped key.
    expect(ModelPrefixPartitionItem._getDyKeyForPkSk(pkSk)).toEqual({
      _pk: `[${tenant}]#mppi`,
      _sk: "shared-name",
    });

    // Read fallback covers both historical shapes:
    //   - bare global prefix            (<= 0.6.0)
    //   - doubled tenant-scoped prefix  (0.6.1)
    expect(ModelPrefixPartitionItem._legacyDyKeysForPkSk(pkSk)).toEqual([
      { _pk: "mppi", _sk: "shared-name" },
      { _pk: `[${tenant}]#mppi#mppi`, _sk: "shared-name" },
    ]);
  });

  test("tenant isolation: each tenant gets a distinct partition key", () => {
    setMode("tenant-scoped");
    registerUnderTenant("tenant-one");
    const k1 = ModelPrefixPartitionItem._getDyKeyForPkSk(pkSk);
    registerUnderTenant("tenant-two");
    const k2 = ModelPrefixPartitionItem._getDyKeyForPkSk(pkSk);
    expect(k1._pk).toBe("[tenant-one]#mppi");
    expect(k2._pk).toBe("[tenant-two]#mppi");
    expect(k1._pk).not.toBe(k2._pk);
  });

  test("composite-key models are unaffected by the migration mode", () => {
    const tenant = "tenant-one";
    registerUnderTenant(tenant);
    const expected = { _pk: `[${tenant}]#comp#alice`, _sk: "doc-1" };
    for (const mode of ["legacy", "migrating", "tenant-scoped"]) {
      setMode(mode);
      expect(
        CompositeItem._getDyKeyForPkSk({ pk: "alice", sk: "doc-1" }),
      ).toEqual(expected);
      expect(
        CompositeItem._legacyDyKeysForPkSk({ pk: "alice", sk: "doc-1" }),
      ).toEqual([]);
    }
  });

  test("with tenancy disabled, tenant-scoped mode falls back to the bare prefix", () => {
    // No tenant set anywhere => getTenantId() is falsy, so there is no [tenant]
    // segment to scope by; the key is the bare prefix (no isolation needed).
    ModelManager.getInstance(null).registerModel(ModelPrefixPartitionItem);
    setMode("tenant-scoped");
    expect(ModelPrefixPartitionItem._getDyKeyForPkSk(pkSk)).toEqual({
      _pk: "mppi",
      _sk: "shared-name",
    });
  });
});
