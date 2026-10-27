// A guarded write (update/delete without a pre-read) that fails its
// condition check must be attributed to the state DynamoDB evaluated it
// against, not to a read taken afterwards. 0.8.0 and 0.8.1 read after the
// failure, so a create landing in between turned "row missing" into
// ConditionalError and broke create-on-miss patterns such as rate limiters.
// Runs against the real table; the documentClient is wrapped so a create
// can be injected between the failed write and any follow-up read.

const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { StringField, CounterField } = require("../src/fields");
const { ConditionalError, ItemNotFoundError } = require("../src/exceptions");

class Window extends BaoModel {
  static modelPrefix = "gfr";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    key: StringField({ required: true }),
    count: CounterField({ defaultValue: 0 }),
  };
  static primaryKey = PrimaryKeyConfig("key");
}

const MODELS = [Window];

// Wrap the client so that, after a chosen command fails, `onFailure` runs
// before the error reaches the library (simulating a concurrent writer).
function interceptClient() {
  const client = Window.documentClient;
  const sent = [];
  let onFailure = null;
  Window.documentClient = {
    send: async (command) => {
      sent.push(command.constructor.name);
      try {
        return await client.send(command);
      } catch (error) {
        if (onFailure && command.constructor.name === "UpdateCommand") {
          const fn = onFailure;
          onFailure = null;
          // Run the "other writer" against the raw client so its commands
          // are neither recorded nor intercepted.
          const wrapper = Window.documentClient;
          Window.documentClient = client;
          try {
            await fn();
          } finally {
            Window.documentClient = wrapper;
          }
        }
        throw error;
      }
    },
  };
  return {
    sent,
    reset: () => sent.splice(0),
    afterFailedUpdate: (fn) => (onFailure = fn),
    restore: () => (Window.documentClient = client),
  };
}

const increment = (key, limit) =>
  Window.update(key, { count: "+1" }, { condition: { count: { $lt: limit } } });

describe("Attributing a failed guarded write", () => {
  let testId;
  let io;

  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();
      const manager = initTestModelsWithTenant(testConfig, testId);
      for (const M of MODELS) manager.registerModel(M);
      await cleanupTestDataByIteration(testId, MODELS);
      await verifyCleanup(testId, MODELS);
    });
    io = interceptClient();
  });

  afterEach(async () => {
    io.restore();
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, MODELS);
        await verifyCleanup(testId, MODELS);
      }
    });
  });

  test("a conditional update of a missing row is ItemNotFoundError even if the row appears right after", async () => {
    const key = ulid();
    await runWithBatchContext(async () => {
      // Another writer creates the row between our failed write and any
      // read the library might do afterwards.
      io.afterFailedUpdate(() =>
        runWithBatchContext(() => Window.create({ key, count: 1 })),
      );
      io.reset();

      await expect(increment(key, 10)).rejects.toThrow(ItemNotFoundError);
      // No follow-up GetItem: the answer came from the failed write itself.
      expect(io.sent).toEqual(["UpdateCommand"]);
    });
  });

  test("a conditional update whose condition fails is ConditionalError without a follow-up read", async () => {
    const key = ulid();
    await runWithBatchContext(() => Window.create({ key, count: 10 }));
    await runWithBatchContext(async () => {
      io.reset();
      await expect(increment(key, 10)).rejects.toThrow(ConditionalError);
      expect(io.sent).toEqual(["UpdateCommand"]);
    });
  });

  test("a conditional delete of a missing row is ItemNotFoundError without a follow-up read", async () => {
    await runWithBatchContext(async () => {
      io.reset();
      await expect(
        Window.delete(ulid(), { condition: { count: { $lt: 10 } } }),
      ).rejects.toThrow(ItemNotFoundError);
      expect(io.sent).toEqual(["DeleteCommand"]);
    });
  });

  test("a conditional delete whose condition fails is ConditionalError without a follow-up read", async () => {
    const key = ulid();
    await runWithBatchContext(() => Window.create({ key, count: 10 }));
    await runWithBatchContext(async () => {
      io.reset();
      await expect(
        Window.delete(key, { condition: { count: { $lt: 10 } } }),
      ).rejects.toThrow(ConditionalError);
      expect(io.sent).toEqual(["DeleteCommand"]);
    });
  });

  test("twenty concurrent create-on-miss incrementers all get through", async () => {
    const key = ulid();
    const limit = 1200;
    io.restore();

    async function caller(delayMs) {
      await new Promise((r) => setTimeout(r, delayMs));
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await runWithBatchContext(() => increment(key, limit));
          return "allowed";
        } catch (error) {
          if (error instanceof ConditionalError) return "refused";
          if (!(error instanceof ItemNotFoundError)) throw error;
          try {
            await runWithBatchContext(() => Window.create({ key, count: 1 }));
            return "allowed";
          } catch (createError) {
            // Lost the create race: retry the increment.
            if (!(createError instanceof ConditionalError)) throw createError;
          }
        }
      }
      return "gave up";
    }

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => caller(i * 8)),
    );
    expect(results.filter((r) => r === "allowed")).toHaveLength(20);

    const row = await runWithBatchContext(() =>
      Window.find(key, { batchDelay: 0, bypassCache: true }),
    );
    expect(row.count).toBe(20);
  });
});
