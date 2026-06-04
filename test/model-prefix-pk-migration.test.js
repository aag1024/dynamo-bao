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
const { ulid } = require("ulid");
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

    // --- Phase 4: backfill relocates the row via the library primitive ---
    await runWithBatchContext(async () => {
      initWithMode(tenantA, "migrating");
      const res = await MpItem.relocateToCanonicalKey(id);
      expect(res.relocated).toBe(true);
      // Idempotent: a second relocate is a no-op.
      const again = await MpItem.relocateToCanonicalKey(id);
      expect(again).toMatchObject({
        relocated: false,
        reason: "already-canonical",
      });
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

  // relocateToCanonicalKey primitive — used by the fleet backfill.
  test("relocateToCanonicalKey moves a 0.6.1 doubled-key row to the clean key", async () => {
    const tenant = `mig-r-${Date.now()}`;
    const id = ulid();
    const doubledPk = `[${tenant}]#${MpItem.modelPrefix}#${MpItem.modelPrefix}`;
    const cleanPk = `[${tenant}]#${MpItem.modelPrefix}`;

    await runWithBatchContext(async () => {
      initWithMode(tenant, "migrating");
      // Seed a row at the 0.6.1 doubled key shape directly.
      await MpItem.documentClient.send(
        new PutCommand({
          TableName: MpItem.table,
          Item: {
            _pk: doubledPk,
            _sk: id,
            itemId: id,
            appId: tenant,
            itemKey: `r-${tenant}`,
            data: "from-0.6.1",
          },
        }),
      );

      const res = await MpItem.relocateToCanonicalKey(id);
      expect(res).toMatchObject({
        relocated: true,
        from: doubledPk,
        to: cleanPk,
      });
    });

    // Now at the clean key, gone from the doubled key, and resolvable.
    expect(await rawGet({ _pk: cleanPk, _sk: id })).not.toBeNull();
    expect(await rawGet({ _pk: doubledPk, _sk: id })).toBeNull();
    await runWithBatchContext(async () => {
      initWithMode(tenant, "tenant-scoped");
      expect((await MpItem.find(id)).data).toBe("from-0.6.1");
    });
    // Raw-seeded row (no unique-constraint pointer) — clean up with a raw delete.
    await MpItem.documentClient.send(
      new DeleteCommand({
        TableName: MpItem.table,
        Key: { _pk: cleanPk, _sk: id },
      }),
    );
  }, 30000);

  test("relocateToCanonicalKey: dry-run writes nothing; not-found is reported; guards enforced", async () => {
    const tenant = `mig-g-${Date.now()}`;
    let id;
    await runWithBatchContext(async () => {
      initWithMode(tenant, "legacy");
      id = (
        await MpItem.create({
          appId: tenant,
          itemKey: `g-${tenant}`,
          data: "d",
        })
      ).itemId;
    });

    await runWithBatchContext(async () => {
      initWithMode(tenant, "migrating");

      // dry-run: reports it would relocate, but the legacy row is untouched.
      const dry = await MpItem.relocateToCanonicalKey(id, { dryRun: true });
      expect(dry).toMatchObject({ relocated: true, reason: "dry-run" });
      expect(await rawGet(bareLegacyKey(id))).not.toBeNull();
      expect(
        await rawGet({ _pk: `[${tenant}]#${MpItem.modelPrefix}`, _sk: id }),
      ).toBeNull();

      // unknown id => not-found, no throw.
      const miss = await MpItem.relocateToCanonicalKey(ulid());
      expect(miss).toMatchObject({ relocated: false, reason: "not-found" });
    });

    // guard: wrong mode throws.
    await runWithBatchContext(async () => {
      initWithMode(tenant, "tenant-scoped");
      await expect(MpItem.relocateToCanonicalKey(id)).rejects.toThrow(
        /migrating/,
      );
    });

    await runWithBatchContext(async () => {
      initWithMode(tenant, "legacy");
      await MpItem.delete(id);
    });
  }, 30000);
});
