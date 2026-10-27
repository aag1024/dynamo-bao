// Regression tests for updates on models whose GSI has "modelPrefix" as one
// half of its key (a "list all rows of this model" index). 0.8.0 stopped
// pre-reading the row on plain updates, and the partial-key guard then
// mistook the constant half for a newly provided key and threw:
//   Update includes GSI partition key "modelPrefix" for index "..." but is
//   missing sort key "...". Include both fields or use forceReindex.
// Runs against the real table; the documentClient is wrapped to count calls.

const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig, IndexConfig } = require("../src/model");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { StringField, CounterField, UlidField } = require("../src/fields");
const { GSI_INDEX_ID1 } = require("../src/constants");

// Index partitioned on the model prefix, sorted by the primary key field.
class AdminUser extends BaoModel {
  static modelPrefix = "mpa";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    adminId: UlidField({ required: true, autoAssign: true }),
    displayName: StringField(),
    createdAppsCount: CounterField({ defaultValue: 0 }),
  };
  static primaryKey = PrimaryKeyConfig("adminId");
  static indexes = {
    allAdmins: IndexConfig("modelPrefix", "adminId", GSI_INDEX_ID1),
  };
}

// Index partitioned on the model prefix, sorted by an ordinary field.
class FeatureFlag extends BaoModel {
  static modelPrefix = "mpf";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    flagId: UlidField({ required: true, autoAssign: true }),
    slot: StringField({ required: true }),
    enabled: StringField(),
  };
  static primaryKey = PrimaryKeyConfig("flagId");
  static indexes = {
    bySlot: IndexConfig("modelPrefix", "slot", GSI_INDEX_ID1),
  };
}

// Index sorted on the model prefix, partitioned by an ordinary field.
class Tagged extends BaoModel {
  static modelPrefix = "mpt";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    id: UlidField({ required: true, autoAssign: true }),
    name: StringField({ required: true }),
    note: StringField(),
  };
  static primaryKey = PrimaryKeyConfig("id");
  static indexes = {
    byName: IndexConfig("name", "modelPrefix", GSI_INDEX_ID1),
  };
}

// The reporter's shape: model-prefix primary key AND a model-prefix index.
class PrefixKeyed extends BaoModel {
  static modelPrefix = "mpk";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    adminId: UlidField({ required: true, autoAssign: true }),
    displayName: StringField(),
    hits: CounterField({ defaultValue: 0 }),
  };
  static primaryKey = PrimaryKeyConfig("modelPrefix", "adminId");
  static indexes = {
    allAdmins: IndexConfig("modelPrefix", "adminId", GSI_INDEX_ID1),
  };
}

const MODELS = [AdminUser, FeatureFlag, Tagged, PrefixKeyed];

function recordCommands() {
  const client = AdminUser.documentClient;
  const sent = [];
  const wrapped = {
    send: (command) => {
      sent.push(command.constructor.name);
      return client.send(command);
    },
  };
  for (const M of MODELS) M.documentClient = wrapped;
  return {
    sent,
    reset: () => sent.splice(0),
    restore: () => {
      for (const M of MODELS) M.documentClient = client;
    },
  };
}

// Seed in a separate batch context so the loader cache does not serve the
// update under test from memory.
const seed = (fn) => runWithBatchContext(fn);

const reload = (Model, id) =>
  Model.find(id, { batchDelay: 0, bypassCache: true });

describe.each(["legacy", "tenant-scoped", "migrating"])(
  "updates on models with a modelPrefix index (modelPrefixPkMode: %s)",
  (mode) => {
    let testId;
    let recorder;

    beforeEach(async () => {
      await runWithBatchContext(async () => {
        testId = ulid();
        const manager = initTestModelsWithTenant(testConfig, testId, {
          keyMigration: { modelPrefixPkMode: mode },
        });
        for (const M of MODELS) manager.registerModel(M);
        await cleanupTestDataByIteration(testId, MODELS);
        await verifyCleanup(testId, MODELS);
      });
      recorder = recordCommands();
    });

    afterEach(async () => {
      recorder.restore();
      await runWithBatchContext(async () => {
        TenantContext.clearTenant();
        if (testId) {
          await cleanupTestDataByIteration(testId, MODELS);
          await verifyCleanup(testId, MODELS);
        }
      });
    });

    test("update of a plain field is one UpdateItem and leaves the index intact", async () => {
      const admin = await seed(() => AdminUser.create({ displayName: "a" }));
      await runWithBatchContext(async () => {
        recorder.reset();
        const updated = await AdminUser.update(admin.adminId, {
          displayName: "b",
        });
        expect(recorder.sent).toEqual(["UpdateCommand"]);
        expect(updated.displayName).toBe("b");

        const stored = await reload(AdminUser, admin.adminId);
        expect(stored.displayName).toBe("b");
        expect(stored._dyData._gsi1_pk).toBe(admin._dyData._gsi1_pk);
        expect(stored._dyData._gsi1_sk).toBe(admin._dyData._gsi1_sk);

        // A modelPrefix-partitioned index is queried by the prefix itself.
        const { items } = await AdminUser.queryByIndex(
          "allAdmins",
          AdminUser.modelPrefix,
        );
        expect(items.map((i) => [i.adminId, i.displayName])).toEqual([
          [admin.adminId, "b"],
        ]);
      });
    });

    test("counter update is one UpdateItem", async () => {
      const admin = await seed(() => AdminUser.create({ displayName: "a" }));
      await runWithBatchContext(async () => {
        recorder.reset();
        const updated = await AdminUser.update(admin.adminId, {
          createdAppsCount: "+3",
        });
        expect(recorder.sent).toEqual(["UpdateCommand"]);
        expect(updated.createdAppsCount).toBe(3);
        expect((await reload(AdminUser, admin.adminId)).createdAppsCount).toBe(
          3,
        );
      });
    });

    test("save() on a loaded instance works and does not rewrite the index key", async () => {
      const admin = await seed(() => AdminUser.create({ displayName: "a" }));
      await runWithBatchContext(async () => {
        const loaded = await reload(AdminUser, admin.adminId);
        recorder.reset();
        loaded.displayName = "c";
        await loaded.save();
        expect(recorder.sent).toEqual(["UpdateCommand"]);
        expect((await reload(AdminUser, admin.adminId)).displayName).toBe("c");
      });
    });

    test("update that leaves the sort-key field alone is one UpdateItem", async () => {
      const flag = await seed(() =>
        FeatureFlag.create({ slot: "s1", enabled: "no" }),
      );
      await runWithBatchContext(async () => {
        recorder.reset();
        await FeatureFlag.update(flag.flagId, { enabled: "yes" });
        expect(recorder.sent).toEqual(["UpdateCommand"]);

        const { items } = await FeatureFlag.queryByIndex(
          "bySlot",
          FeatureFlag.modelPrefix,
        );
        expect(items.map((i) => [i.slot, i.enabled])).toEqual([["s1", "yes"]]);
      });
    });

    test("update of the sort-key field moves the row in the index", async () => {
      const flag = await seed(() =>
        FeatureFlag.create({ slot: "s1", enabled: "no" }),
      );
      await runWithBatchContext(async () => {
        recorder.reset();
        await FeatureFlag.update(flag.flagId, { slot: "s2" });
        // The sort key is an index key, so the row is read before the write.
        expect(recorder.sent).toEqual(["GetCommand", "UpdateCommand"]);

        const stored = await reload(FeatureFlag, flag.flagId);
        expect(stored._dyData._gsi1_sk).toBe("s2");
        const { items } = await FeatureFlag.queryByIndex(
          "bySlot",
          FeatureFlag.modelPrefix,
          { slot: "s2" },
        );
        expect(items.map((i) => i.flagId)).toEqual([flag.flagId]);
      });
    });

    test("index with modelPrefix as the sort key: plain update is one UpdateItem", async () => {
      const tagged = await seed(() => Tagged.create({ name: "n", note: "x" }));
      await runWithBatchContext(async () => {
        recorder.reset();
        await Tagged.update(tagged.id, { note: "y" });
        expect(recorder.sent).toEqual(["UpdateCommand"]);

        const { items } = await Tagged.queryByIndex("byName", "n");
        expect(items.map((i) => i.note)).toEqual(["y"]);
      });
    });

    test("index with modelPrefix as the sort key: partition-field update moves the row", async () => {
      const tagged = await seed(() => Tagged.create({ name: "n", note: "x" }));
      await runWithBatchContext(async () => {
        recorder.reset();
        await Tagged.update(tagged.id, { name: "m" });
        expect(recorder.sent).toEqual(["GetCommand", "UpdateCommand"]);

        expect((await Tagged.queryByIndex("byName", "n")).items).toEqual([]);
        const { items } = await Tagged.queryByIndex("byName", "m");
        expect(items.map((i) => i.id)).toEqual([tagged.id]);
      });
    });

    test("model-prefix primary key with a model-prefix index: plain and counter updates work", async () => {
      const row = await seed(() => PrefixKeyed.create({ displayName: "a" }));
      await runWithBatchContext(async () => {
        recorder.reset();
        const updated = await PrefixKeyed.update(row.getPrimaryId(), {
          displayName: "b",
          hits: "+1",
        });
        // In migrating mode the row is written in place at whichever key it
        // currently lives at, which needs a read first. The other modes do
        // not.
        expect(recorder.sent).toEqual(
          mode === "migrating"
            ? ["GetCommand", "UpdateCommand"]
            : ["UpdateCommand"],
        );
        expect(updated.displayName).toBe("b");
        expect(updated.hits).toBe(1);

        const stored = await reload(PrefixKeyed, row.getPrimaryId());
        expect(stored.displayName).toBe("b");
        expect(stored.hits).toBe(1);
        const { items } = await PrefixKeyed.queryByIndex(
          "allAdmins",
          PrefixKeyed.modelPrefix,
        );
        expect(items.map((i) => [i.adminId, i.displayName])).toEqual([
          [row.adminId, "b"],
        ]);
      });
    });
  },
);
