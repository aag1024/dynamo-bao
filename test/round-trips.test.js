// Pins the number of DynamoDB calls the core operations make, so a change
// that quietly adds a read or a timer shows up here. Runs against the real
// table; the documentClient is wrapped (not stubbed) to count commands.

const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  BaoModel,
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
} = require("../src/model");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const {
  StringField,
  IntegerField,
  CounterField,
  UlidField,
  VersionField,
  StringSetField,
} = require("../src/fields");
const { GSI_INDEX_ID1, UNIQUE_CONSTRAINT_ID1 } = require("../src/constants");
const { ConditionalError, ItemNotFoundError } = require("../src/exceptions");

class Plain extends BaoModel {
  static modelPrefix = "rtp";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    id: UlidField({ required: true, autoAssign: true }),
    name: StringField({ required: true }),
    note: StringField(),
    count: CounterField({ defaultValue: 0 }),
    version: VersionField(),
  };
  static primaryKey = PrimaryKeyConfig("id");
}

class Indexed extends BaoModel {
  static modelPrefix = "rti";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    id: UlidField({ required: true, autoAssign: true }),
    name: StringField({ required: true }),
    status: StringField({ required: true }),
    rank: IntegerField({ defaultValue: 0 }),
    email: StringField(),
    tags: StringSetField(),
    hits: CounterField({ defaultValue: 0 }),
  };
  static primaryKey = PrimaryKeyConfig("id");
  static indexes = {
    byStatus: IndexConfig("status", "rank", GSI_INDEX_ID1),
  };
  static uniqueConstraints = {
    uniqueEmail: UniqueConstraintConfig("email", UNIQUE_CONSTRAINT_ID1),
  };
}

class Bucketed extends BaoModel {
  static modelPrefix = "rtb";
  static iterable = true;
  static iterationBuckets = 4;
  static fields = {
    id: UlidField({ required: true, autoAssign: true }),
    name: StringField({ required: true }),
  };
  static primaryKey = PrimaryKeyConfig("id");
}

const MODELS = [Plain, Indexed, Bucketed];

// Wrap the shared document client so every command's name is recorded.
function recordCommands(model) {
  const client = model.documentClient;
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

// Create rows in their own batch context: a create primes the request-scoped
// loader cache, which would otherwise serve the find/pre-read under test
// from memory instead of DynamoDB.
const seed = (fn) => runWithBatchContext(fn);

describe("DynamoDB round trips per operation", () => {
  let testId;
  let recorder;

  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();
      const manager = initTestModelsWithTenant(testConfig, testId);
      for (const M of MODELS) manager.registerModel(M);
      await cleanupTestDataByIteration(testId, MODELS);
      await verifyCleanup(testId, MODELS);
    });
    recorder = recordCommands(Plain);
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

  describe("find batching", () => {
    test("finds issued in the same tick share one BatchGetItem with no delay option", async () => {
      const created = await seed(() =>
        Promise.all([1, 2, 3].map((i) => Plain.create({ name: `n${i}` }))),
      );
      await runWithBatchContext(async () => {
        recorder.reset();

        const found = await Promise.all(created.map((c) => Plain.find(c.id)));

        expect(recorder.sent).toEqual(["BatchGetCommand"]);
        expect(found.map((f) => f.name).sort()).toEqual(["n1", "n2", "n3"]);
      });
    });

    test("a find issued after an await still joins finds from the same tick", async () => {
      const [a, b] = await seed(() =>
        Promise.all([Plain.create({ name: "a" }), Plain.create({ name: "b" })]),
      );
      await runWithBatchContext(async () => {
        recorder.reset();

        const first = Plain.find(a.id, { bypassCache: true }).then(() => {});
        // Microtasks run before the batch flushes, so this joins the batch.
        const second = Promise.resolve().then(() => Plain.find(b.id));
        const third = Plain.find(a.id);
        await Promise.all([first, second, third]);

        // The bypassCache find is its own GetItem; the other two batch.
        expect(recorder.sent.sort()).toEqual(["BatchGetCommand", "GetCommand"]);
      });
    });

    test("sequential finds do not wait on a timer", async () => {
      // Stub the client so only the library's own scheduling costs time.
      // Each batched find used to sit on a 5 ms timer, so 20 sequential
      // finds took over 100 ms; with a next-tick flush they take a few ms.
      const item = await runWithBatchContext(() => Plain.create({ name: "s" }));
      const dyItem = { ...item._dyData };
      const stub = {
        send: async (command) => {
          if (command.constructor.name !== "BatchGetCommand") {
            throw new Error(`unexpected ${command.constructor.name}`);
          }
          const keys = command.input.RequestItems[Plain.table].Keys;
          return {
            Responses: { [Plain.table]: keys.map(() => ({ ...dyItem })) },
            ConsumedCapacity: [{ CapacityUnits: 0.5 }],
          };
        },
      };
      Plain.documentClient = stub;
      try {
        const start = Date.now();
        await runWithBatchContext(async () => {
          for (let i = 0; i < 20; i++) {
            await Plain.find(item.id, { bypassCache: false });
            Plain._evictFromLoaderContext(item.id); // force a real fetch each time
          }
        });
        expect(Date.now() - start).toBeLessThan(40);
      } finally {
        recorder.restore();
        recorder = recordCommands(Plain);
      }
    });
  });

  describe("update by id", () => {
    test("a plain field update is a single UpdateItem", async () => {
      const item = await seed(() => Plain.create({ name: "x" }));
      await runWithBatchContext(async () => {
        recorder.reset();

        const updated = await Plain.update(item.id, { note: "hello" });

        expect(recorder.sent).toEqual(["UpdateCommand"]);
        expect(updated.note).toBe("hello");
        expect(updated.name).toBe("x");
        expect(updated.version).not.toBe(item.version);
      });
    });

    test("a plain update of a missing row throws ItemNotFoundError and writes nothing", async () => {
      await runWithBatchContext(async () => {
        const missingId = ulid();
        recorder.reset();

        await expect(
          Plain.update(missingId, { note: "hello" }),
        ).rejects.toThrow(ItemNotFoundError);
        expect(recorder.sent).toEqual(["UpdateCommand"]);

        const check = await Plain.find(missingId, { bypassCache: true });
        expect(check.exists()).toBe(false);
      });
    });

    test("a conditional update of a missing row still reports ItemNotFoundError", async () => {
      await runWithBatchContext(async () => {
        await expect(
          Plain.update(ulid(), { note: "hello" }, { condition: { name: "x" } }),
        ).rejects.toThrow(ItemNotFoundError);
      });
    });

    test("a conditional update whose condition fails reports ConditionalError", async () => {
      await runWithBatchContext(async () => {
        const item = await Plain.create({ name: "x" });
        await expect(
          Plain.update(
            item.id,
            { note: "hello" },
            { condition: { name: "y" } },
          ),
        ).rejects.toThrow(ConditionalError);
      });
    });

    test("an update touching a GSI key reads first so the key pair stays whole", async () => {
      const item = await seed(() =>
        Indexed.create({ name: "x", status: "a", rank: 1 }),
      );
      await runWithBatchContext(async () => {
        recorder.reset();

        await Indexed.update(item.id, { status: "b" });

        expect(recorder.sent).toEqual(["GetCommand", "UpdateCommand"]);
        const viaIndex = await Indexed.queryByIndex("byStatus", "b");
        expect(viaIndex.items.map((i) => i.id)).toEqual([item.id]);
      });
    });

    test("an update touching a unique constraint or a StringSet reads first", async () => {
      const item = await seed(() =>
        Indexed.create({ name: "x", status: "a", email: "a@example.com" }),
      );
      await runWithBatchContext(async () => {
        recorder.reset();
        await Indexed.update(item.id, { email: "b@example.com" });
        expect(recorder.sent[0]).toBe("GetCommand");
      });
      await runWithBatchContext(async () => {
        recorder.reset();
        await Indexed.update(item.id, { tags: new Set(["t1"]) });
        expect(recorder.sent).toEqual(["GetCommand", "UpdateCommand"]);
      });
    });

    test("a relative counter update that is not indexed needs no read", async () => {
      const item = await seed(() => Plain.create({ name: "x", count: 2 }));
      await runWithBatchContext(async () => {
        recorder.reset();

        const updated = await Plain.update(item.id, { count: "+3" });

        expect(recorder.sent).toEqual(["UpdateCommand"]);
        expect(updated.count).toBe(5);
      });
    });
  });

  describe("delete by id", () => {
    test("deleting from a model without unique constraints is a single DeleteItem", async () => {
      const item = await seed(() => Plain.create({ name: "x" }));
      await runWithBatchContext(async () => {
        recorder.reset();

        const deleted = await Plain.delete(item.id);

        expect(recorder.sent).toEqual(["DeleteCommand"]);
        expect(deleted.name).toBe("x");
        expect(deleted.getNumericConsumedCapacity("write")).toBeGreaterThan(0);
        const check = await Plain.find(item.id, { bypassCache: true });
        expect(check.exists()).toBe(false);
      });
    });

    test("deleting a missing row throws ItemNotFoundError", async () => {
      await runWithBatchContext(async () => {
        await expect(Plain.delete(ulid())).rejects.toThrow(ItemNotFoundError);
        await expect(
          Plain.delete(ulid(), { condition: { name: "x" } }),
        ).rejects.toThrow(ItemNotFoundError);
      });
    });

    test("a delete whose condition fails reports ConditionalError", async () => {
      await runWithBatchContext(async () => {
        const item = await Plain.create({ name: "x" });
        await expect(
          Plain.delete(item.id, { condition: { name: "y" } }),
        ).rejects.toThrow(ConditionalError);
        const check = await Plain.find(item.id, { bypassCache: true });
        expect(check.exists()).toBe(true);
      });
    });

    test("deleting from a model with unique constraints still reads first", async () => {
      const item = await seed(() =>
        Indexed.create({ name: "x", status: "a", email: "c@example.com" }),
      );
      await runWithBatchContext(async () => {
        recorder.reset();

        await Indexed.delete(item.id);

        expect(recorder.sent).toEqual(["GetCommand", "TransactWriteCommand"]);
        const again = await Indexed.create({
          name: "y",
          status: "a",
          email: "c@example.com",
        });
        expect(again.email).toBe("c@example.com");
      });
    });
  });

  describe("hydration", () => {
    test("loading a row does not generate throwaway initial values", async () => {
      await runWithBatchContext(async () => {
        const item = await Plain.create({ name: "x" });
        const idSpy = jest.spyOn(Plain.fields.id, "getInitialValue");
        const versionSpy = jest.spyOn(Plain.fields.version, "getInitialValue");
        try {
          const loaded = await Plain.find(item.id, { bypassCache: true });
          expect(loaded.id).toBe(item.id);
          expect(loaded.version).toBe(item.version);
          expect(idSpy).not.toHaveBeenCalled();
          expect(versionSpy).not.toHaveBeenCalled();

          // Hydrated instances still track changes through their accessors.
          loaded.note = "changed";
          expect(loaded.hasChanges()).toBe(true);
          expect(loaded.isLoaded()).toBe(true);
        } finally {
          idSpy.mockRestore();
          versionSpy.mockRestore();
        }
      });
    });

    test("a new instance still gets its initial values", () => {
      const fresh = new Plain({ name: "x" });
      expect(fresh.id).toMatch(/^[0-9A-Z]{26}$/);
      expect(fresh.version).toMatch(/^[0-9A-Z]{26}$/);
      expect(fresh.count).toBe(0);
      expect(fresh.isLoaded()).toBe(false);
    });

    test("field accessors live on the prototype, once per class", () => {
      const fresh = new Plain({ name: "x" });
      expect(Object.getOwnPropertyNames(fresh)).not.toContain("name");
      expect(Object.getOwnPropertyNames(Plain.prototype)).toContain("name");

      // A subclass with its own fields gets its own accessors without
      // disturbing the parent's.
      class Sub extends Plain {
        static fields = { ...Plain.fields, extra: StringField() };
      }
      const sub = new Sub({ name: "y", extra: "z" });
      expect(sub.extra).toBe("z");
      expect(Object.getOwnPropertyNames(Plain.prototype)).not.toContain(
        "extra",
      );
      sub.name = "changed";
      expect(sub.hasChanges()).toBe(true);
      expect(fresh.name).toBe("x");
    });
  });

  describe("expected write failures", () => {
    test("a condition failure or unique collision is not logged at ERROR", async () => {
      const [a] = await seed(() =>
        Promise.all([
          Indexed.create({ name: "a", status: "a", email: "dup@example.com" }),
          Indexed.create({
            name: "b",
            status: "a",
            email: "other@example.com",
          }),
        ]),
      );
      const spy = jest.spyOn(console, "log").mockImplementation(() => {});
      try {
        await runWithBatchContext(async () => {
          // Caller condition not met on the plain UpdateItem path.
          await expect(
            Plain.update(ulid(), { note: "x" }, { condition: { name: "x" } }),
          ).rejects.toThrow(ItemNotFoundError);
          // Taken unique value on the transaction path.
          await expect(
            Indexed.create({
              name: "c",
              status: "a",
              email: "dup@example.com",
            }),
          ).rejects.toThrow(ConditionalError);
          // Duplicate primary key on create.
          await expect(
            Indexed.create({ id: a.id, name: "d", status: "a" }),
          ).rejects.toThrow(ConditionalError);
        });
        const errorLines = spy.mock.calls.filter(
          (args) =>
            typeof args[0] === "string" && args[0].startsWith("[ERROR]"),
        );
        expect(errorLines).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("unique-constraint writes", () => {
    test("a SET-only update with a unique change is one read and one transaction", async () => {
      const item = await seed(() =>
        Indexed.create({ name: "x", status: "a", email: "u1@example.com" }),
      );
      await runWithBatchContext(async () => {
        recorder.reset();

        const updated = await Indexed.update(item.id, {
          email: "u2@example.com",
          name: "renamed",
        });

        expect(recorder.sent).toEqual(["GetCommand", "TransactWriteCommand"]);
        // Written fields, untouched fields, and the key all come through.
        expect(updated.email).toBe("u2@example.com");
        expect(updated.name).toBe("renamed");
        expect(updated.status).toBe("a");
        expect(updated.getPrimaryId()).toBe(item.id);
        expect(updated.getNumericConsumedCapacity("write")).toBeGreaterThan(0);

        // The locally built row matches what DynamoDB holds, and a later
        // find in the same request is served from the primed cache.
        recorder.reset();
        const cached = await Indexed.find(item.id);
        expect(recorder.sent).toEqual([]);
        expect(cached.email).toBe("u2@example.com");
      });
      await runWithBatchContext(async () => {
        const stored = await Indexed.find(item.id, { bypassCache: true });
        expect(stored._dyData).toEqual(
          expect.objectContaining({
            email: "u2@example.com",
            name: "renamed",
            status: "a",
          }),
        );
        // The old email is free again.
        const other = await Indexed.create({
          name: "o",
          status: "a",
          email: "u1@example.com",
        });
        expect(other.email).toBe("u1@example.com");
      });
    });

    test("a unique change combined with a counter ADD still reads the result back", async () => {
      const item = await seed(() =>
        Indexed.create({ name: "x", status: "a", email: "c1@example.com" }),
      );
      await runWithBatchContext(async () => {
        recorder.reset();

        const updated = await Indexed.update(item.id, {
          email: "c2@example.com",
          hits: "+2",
        });

        expect(recorder.sent).toEqual([
          "GetCommand",
          "TransactWriteCommand",
          "GetCommand",
        ]);
        expect(updated.hits).toBe(2);
        expect(updated.email).toBe("c2@example.com");
      });
    });
  });

  describe("bulk reads", () => {
    test("batchFind splits ids into 100-key requests and returns every row", async () => {
      const created = await seed(() =>
        Promise.all(
          Array.from({ length: 120 }, (_, i) =>
            Plain.create({ name: `b${i}` }),
          ),
        ),
      );
      const ids = created.map((c) => c.id);
      await runWithBatchContext(async () => {
        recorder.reset();

        const { items } = await Plain.batchFind([...ids, ids[0], ulid()]);

        expect(recorder.sent).toEqual(["BatchGetCommand", "BatchGetCommand"]);
        expect(Object.keys(items).sort()).toEqual([...ids].sort());
      });
    });

    test("iterateAll with concurrency yields every row exactly once across buckets", async () => {
      const created = await seed(() =>
        Promise.all(
          Array.from({ length: 30 }, (_, i) =>
            Bucketed.create({ name: `i${i}` }),
          ),
        ),
      );
      const expected = created.map((c) => c.id).sort();

      for (const concurrency of [1, 4]) {
        await runWithBatchContext(async () => {
          const seen = [];
          for await (const batch of Bucketed.iterateAll({
            batchSize: 4,
            concurrency,
          })) {
            expect(batch.length).toBeGreaterThan(0);
            expect(batch.length).toBeLessThanOrEqual(4);
            seen.push(...batch.map((b) => b.id));
          }
          expect(seen.sort()).toEqual(expected);
        });
      }
    });

    test("batchFind returns the cached instance for ids already in the loader cache", async () => {
      const item = await seed(() => Plain.create({ name: "cached" }));
      await runWithBatchContext(async () => {
        const first = await Plain.find(item.id);
        recorder.reset();

        const { items } = await Plain.batchFind([item.id]);

        expect(recorder.sent).toEqual([]);
        expect(items[item.id]).toBe(first);
      });
    });

    test("breaking out of a concurrent iteration stops cleanly", async () => {
      await seed(() =>
        Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            Bucketed.create({ name: `k${i}` }),
          ),
        ),
      );
      await runWithBatchContext(async () => {
        let batches = 0;
        for await (const batch of Bucketed.iterateAll({
          batchSize: 2,
          concurrency: 4,
        })) {
          expect(batch.length).toBeGreaterThan(0);
          if (++batches === 1) break;
        }
        expect(batches).toBe(1);
      });
      // Let any prefetched requests settle; an unhandled rejection here
      // would fail the run.
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  });
});
