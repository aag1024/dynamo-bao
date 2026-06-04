/**
 * Integration test for the pk === "modelPrefix" tenant-scoping migration.
 *
 * Exercises the full expand/migrate/contract lifecycle against a real table:
 *   legacy write -> migrating read-fallback -> migrating in-place update
 *   -> backfill relocate -> tenant-scoped read -> cross-tenant isolation
 *   -> delete-at-legacy.
 */
const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  BaoModel,
  PrimaryKeyConfig,
  UniqueConstraintConfig,
} = require("../src/model");
const { StringField, UlidField } = require("../src/fields");
const { ModelManager } = require("../src/model-manager");
const { UNIQUE_CONSTRAINT_ID1 } = require("../src/constants");
const {
  GetCommand,
  PutCommand,
  DeleteCommand,
} = require("../src/dynamodb-client");
// (PutCommand was added to the client wrapper as part of this change.)

class MpItem extends BaoModel {
  static modelPrefix = "mpmig";

  static fields = {
    itemId: UlidField({ autoAssign: true, required: true }),
    appId: StringField({ required: true }),
    itemKey: StringField({ required: true }),
    data: StringField(),
  };

  static primaryKey = PrimaryKeyConfig("modelPrefix", "itemId");

  static uniqueConstraints = {
    itemKeyUnique: UniqueConstraintConfig("itemKey", UNIQUE_CONSTRAINT_ID1),
  };
}

function initWithMode(tenantId, mode) {
  TenantContext.setCurrentTenant(tenantId);
  const manager = dynamoBao.initModels({
    ...testConfig,
    tenancy: { enabled: true },
    keyMigration: { modelPrefixPkMode: mode },
  });
  manager.registerModel(MpItem);
  return manager;
}

const rawGet = (Key) =>
  MpItem.documentClient
    .send(new GetCommand({ TableName: MpItem.table, Key }))
    .then((r) => r.Item || null);

const bareLegacyKey = (id) => ({ _pk: MpItem.modelPrefix, _sk: id });

describe("pk === modelPrefix tenant-scoping migration (integration)", () => {
  afterEach(() => {
    TenantContext.clearTenant();
    TenantContext.reset();
  });

  test("full lifecycle: legacy write, migrating fallback+in-place update, backfill, tenant-scoped read", async () => {
    const tenantA = `mig-A-${Date.now()}`;
    let id;

    // --- Phase 1: write under LEGACY mode (bare global key) ---
    await runWithBatchContext(async () => {
      initWithMode(tenantA, "legacy");
      const created = await MpItem.create({
        appId: tenantA,
        itemKey: "alpha",
        data: "v1",
      });
      id = created.itemId;
    });

    // Stored at the bare legacy key.
    expect(await rawGet(bareLegacyKey(id))).not.toBeNull();

    // --- Phase 2: switch to MIGRATING; read must fall back to legacy key ---
    await runWithBatchContext(async () => {
      initWithMode(tenantA, "migrating");

      const canonicalKey = MpItem._getDyKeyForPkSk({
        pk: MpItem.modelPrefix,
        sk: id,
      });
      // Canonical key is the clean tenant-scoped pk, and is empty so far.
      expect(canonicalKey._pk).toBe(`[${tenantA}]#mpmig`);
      expect(await rawGet(canonicalKey)).toBeNull();

      // find() resolves via legacy fallback.
      const found = await MpItem.find(id);
      expect(found.exists()).toBe(true);
      expect(found.data).toBe("v1");
    });

    // --- Phase 3: update in MIGRATING mode writes IN PLACE at the legacy key ---
    await runWithBatchContext(async () => {
      const updated = await MpItem.update(id, { data: "v2" });
      expect(updated.data).toBe("v2");
    });
    // Still at the legacy key (no partial duplicate at the canonical key).
    const legacyRow = await rawGet(bareLegacyKey(id));
    expect(legacyRow).not.toBeNull();
    expect(legacyRow.data).toBe("v2");
    await runWithBatchContext(async () => {
      initWithMode(tenantA, "migrating");
      const canonicalKey = MpItem._getDyKeyForPkSk({
        pk: MpItem.modelPrefix,
        sk: id,
      });
      expect(await rawGet(canonicalKey)).toBeNull();
    });

    // --- Phase 4: backfill relocates the row to the canonical key ---
    await runWithBatchContext(async () => {
      initWithMode(tenantA, "migrating");
      const canonicalKey = MpItem._getDyKeyForPkSk({
        pk: MpItem.modelPrefix,
        sk: id,
      });
      const row = await rawGet(bareLegacyKey(id));
      await MpItem.documentClient.send(
        new PutCommand({
          TableName: MpItem.table,
          Item: { ...row, _pk: canonicalKey._pk },
        }),
      );
      await MpItem.documentClient.send(
        new DeleteCommand({ TableName: MpItem.table, Key: bareLegacyKey(id) }),
      );
    });

    // --- Phase 5: CONTRACT to tenant-scoped; resolves at canonical key only ---
    await runWithBatchContext(async () => {
      initWithMode(tenantA, "tenant-scoped");
      const found = await MpItem.find(id);
      expect(found.exists()).toBe(true);
      expect(found.data).toBe("v2");
    });
    expect(await rawGet(bareLegacyKey(id))).toBeNull();

    // --- Phase 6: cross-tenant isolation — tenant B cannot read tenant A's id ---
    await runWithBatchContext(async () => {
      const tenantB = `mig-B-${Date.now()}`;
      initWithMode(tenantB, "tenant-scoped");
      const found = await MpItem.find(id);
      expect(found.exists()).toBe(false); // <-- the isolation win
    });

    // cleanup
    await runWithBatchContext(async () => {
      initWithMode(tenantA, "tenant-scoped");
      await MpItem.delete(id);
    });
  }, 30000);

  test("delete in migrating mode removes the row at its legacy key", async () => {
    const tenant = `mig-del-${Date.now()}`;
    let id;

    await runWithBatchContext(async () => {
      initWithMode(tenant, "legacy");
      const created = await MpItem.create({
        appId: tenant,
        itemKey: "to-delete",
        data: "x",
      });
      id = created.itemId;
    });
    expect(await rawGet(bareLegacyKey(id))).not.toBeNull();

    await runWithBatchContext(async () => {
      initWithMode(tenant, "migrating");
      const deleted = await MpItem.delete(id); // finds via fallback, deletes at legacy key
      expect(deleted.exists()).toBe(true);
    });

    expect(await rawGet(bareLegacyKey(id))).toBeNull();
    await runWithBatchContext(async () => {
      initWithMode(tenant, "migrating");
      const found = await MpItem.find(id);
      expect(found.exists()).toBe(false);
    });
  }, 30000);

  // P1a: writes and primary-key queries must agree in every mode. Legacy mode
  // is the interesting case — before this fix the write used the bare key while
  // the query computed the doubled key, so a primary-key query never found its
  // own rows. (Tenant-scoped consistency is covered by tenant-isolation.test.js.)
  test("legacy mode: a primary-key query finds the rows it wrote", async () => {
    const tenant = `mig-q-${Date.now()}`;
    let id;
    await runWithBatchContext(async () => {
      initWithMode(tenant, "legacy");
      const created = await MpItem.create({
        appId: tenant,
        itemKey: `q-${tenant}`,
        data: "q",
      });
      id = created.itemId;

      const res = await MpItem.queryByPrimaryKey(MpItem.modelPrefix);
      expect(res.items.map((i) => i.itemId)).toContain(id);
    });

    await runWithBatchContext(async () => {
      initWithMode(tenant, "legacy");
      await MpItem.delete(id);
    });
  }, 30000);
});
