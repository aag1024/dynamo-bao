const dynamoBao = require("../../src");
const { TenantContext, runWithBatchContext, getBatchContextCapacity } = dynamoBao;
const testConfig = require("../config");
const { BaoModel, PrimaryKeyConfig } = require("../../src/model");
const { StringField, UlidField, RelatedField } = require("../../src/fields");
const {
  createContext,
  fresh,
  bindModelsToTenant,
  runInCall,
} = require("../../src/remote/context");
const {
  cleanupTestDataByIteration,
  initTestModelsWithTenant,
} = require("../utils/test-utils");
const { ulid } = require("ulid");

class CtxThing extends BaoModel {
  static modelPrefix = "rctx";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    thingId: UlidField({ autoAssign: true }),
    name: StringField(),
    parent: RelatedField("CtxThing"),
  };
  static primaryKey = PrimaryKeyConfig("thingId");
}

let appTenant, adminTenant;

beforeAll(() => {
  appTenant = ulid();
  adminTenant = `${appTenant}-admin`;
  const manager = initTestModelsWithTenant(testConfig, appTenant);
  manager.registerModel(CtxThing);
  TenantContext.setDefaultTenant(null);
});

afterAll(async () => {
  await cleanupTestDataByIteration(appTenant, [CtxThing]);
  await cleanupTestDataByIteration(adminTenant, [CtxThing]);
  TenantContext.reset();
});

const actor = Object.freeze({
  kind: "system",
  appId: "app_1",
  systemAuthority: true,
  preAuthenticated: false,
  adminPartition: "admin_9",
  futureField: { nested: [1, 2] },
});

function makeCtx(overrides = {}) {
  return createContext({
    tenant: appTenant,
    actor,
    requestId: "req-1",
    operationId: "op-1",
    scope: "app",
    models: { CtxThing },
    ...overrides,
  });
}

describe("createContext: fields", () => {
  test("carries tenant as a value, request and operation ids, and models", () => {
    const ctx = makeCtx();
    expect(ctx.tenant).toBe(appTenant);
    expect(ctx.requestId).toBe("req-1");
    expect(ctx.operationId).toBe("op-1");
    expect(ctx.models.CtxThing).toBe(CtxThing);
  });

  test("the context and its tenant are read-only", () => {
    const ctx = makeCtx();
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      "use strict";
      ctx.tenant = "other";
    }).toThrow(TypeError);
  });

  test("passes the actor through untouched, including fields it does not know", () => {
    const ctx = makeCtx();
    expect(ctx.actor).toEqual(actor);
    expect(Object.isFrozen(ctx.actor)).toBe(true);
    expect(ctx.actor.futureField.nested).toEqual([1, 2]);
  });

  test("now() defaults to the wall clock and can be pinned", () => {
    const before = Date.now();
    const t = makeCtx().now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
    expect(makeCtx({ now: () => 1234 }).now()).toBe(1234);
  });

  test("config is a frozen copy of plain settings", () => {
    const config = { DB_PERF_CACHE_ENABLED: "true", limits: { max: 3 } };
    const ctx = makeCtx({ config });
    expect(ctx.config).toEqual(config);
    expect(Object.isFrozen(ctx.config.limits)).toBe(true);
    config.limits.max = 99;
    expect(ctx.config.limits.max).toBe(3);
    expect(makeCtx().config).toEqual({});
  });

  test("config refuses bindings and other non-JSON values", () => {
    expect(() => makeCtx({ config: { DATA: { fetch() {} } } })).toThrow(
      /config\.DATA.*function/,
    );
    expect(() => makeCtx({ config: { BUCKET: new (class R2Bucket {})() } })).toThrow(
      /config\.BUCKET.*R2Bucket/,
    );
  });

  test("refuses a context without tenant, actor or models", () => {
    expect(() => makeCtx({ tenant: undefined })).toThrow(/tenant/);
    expect(() => makeCtx({ actor: undefined })).toThrow(/actor/);
    expect(() => makeCtx({ models: undefined })).toThrow(/models/);
  });

  test("adminModels is absent for scope app even if supplied", () => {
    const ctx = makeCtx({ scope: "app", adminModels: { CtxThing } });
    expect(ctx.adminModels).toBeUndefined();
    expect("adminModels" in ctx).toBe(false);
  });

  test.each(["admin", "both"])("adminModels is present for scope %s", (scope) => {
    const ctx = makeCtx({ scope, adminModels: { CtxThing } });
    expect(ctx.adminModels.CtxThing.name).toBe("CtxThing");
  });

  test("scope admin without adminModels is refused", () => {
    expect(() => makeCtx({ scope: "admin" })).toThrow(/adminModels/);
  });
});

describe("createContext: logger", () => {
  function recorder() {
    const lines = [];
    const base = {};
    for (const level of ["debug", "info", "warn", "error"]) {
      base[level] = (message, detail) => lines.push({ level, message, detail });
    }
    return { base, lines };
  }

  test("each level is bound to requestId and tenant", () => {
    const { base, lines } = recorder();
    const ctx = makeCtx({ logger: base });
    ctx.logger.info("hello", { a: 1 });
    ctx.logger.warn("careful");
    ctx.logger.debug("dbg", { b: 2 });
    ctx.logger.error("bad", { c: 3 });
    expect(lines).toEqual([
      { level: "info", message: "hello", detail: { requestId: "req-1", tenant: appTenant, a: 1 } },
      { level: "warn", message: "careful", detail: { requestId: "req-1", tenant: appTenant } },
      { level: "debug", message: "dbg", detail: { requestId: "req-1", tenant: appTenant, b: 2 } },
      { level: "error", message: "bad", detail: { requestId: "req-1", tenant: appTenant, c: 3 } },
    ]);
  });

  test("a non-object detail is kept under detail", () => {
    const { base, lines } = recorder();
    makeCtx({ logger: base }).logger.info("n", 42);
    expect(lines[0].detail).toEqual({ requestId: "req-1", tenant: appTenant, detail: 42 });
  });

  test("defaults to a console logger with the same signature", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      makeCtx().logger.warn("w", { x: 1 });
      expect(spy).toHaveBeenCalledWith("w", { requestId: "req-1", tenant: appTenant, x: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createContext: waitUntil", () => {
  test("hands each deferred promise to the sink, capped", async () => {
    const handed = [];
    const ctx = makeCtx({ waitUntil: (p) => handed.push(p) });
    let resolve;
    const work = new Promise((r) => (resolve = r));
    ctx.waitUntil(work);
    expect(handed).toHaveLength(1);
    resolve("done");
    await expect(handed[0]).resolves.toBeUndefined();
  });

  test("a failure in deferred work is logged, never thrown", async () => {
    const handed = [];
    const errors = [];
    const ctx = makeCtx({
      waitUntil: (p) => handed.push(p),
      logger: { ...console, error: (m, d) => errors.push({ m, d }) },
    });
    ctx.waitUntil(Promise.reject(new Error("boom")));
    await expect(handed[0]).resolves.toBeUndefined();
    expect(errors[0].m).toMatch(/deferred work failed/);
    expect(errors[0].d.error).toMatch(/boom/);
  });

  test("work still pending at the cap is abandoned and logged", async () => {
    const handed = [];
    const warns = [];
    const ctx = makeCtx({
      waitUntil: (p) => handed.push(p),
      waitUntilCapMs: 20,
      logger: { ...console, warn: (m, d) => warns.push({ m, d }) },
    });
    ctx.waitUntil(new Promise(() => {}));
    await expect(handed[0]).resolves.toBeUndefined();
    expect(warns[0].m).toMatch(/deferred work exceeded 20 ms/);
  });

  test("the default cap is 30 s", () => {
    expect(require("../../src/remote/context").WAIT_UNTIL_CAP_MS).toBe(30_000);
  });

  test("refuses something that is not a promise", () => {
    const ctx = makeCtx({ waitUntil: () => {} });
    expect(() => ctx.waitUntil(() => 1)).toThrow(/promise/);
  });

  test("without a sink the work is still awaited by drain()", async () => {
    let done = false;
    const pending = [];
    const ctx = makeCtx({ waitUntil: (p) => pending.push(p) });
    ctx.waitUntil(new Promise((r) => setTimeout(() => ((done = true), r()), 10)));
    await Promise.all(pending);
    expect(done).toBe(true);
  });
});

describe("runInCall", () => {
  test("enters the tenant and a fresh batch context, and reports its capacity", async () => {
    const { value, capacity } = await runInCall(appTenant, async () => {
      expect(TenantContext.getCurrentTenant()).toBe(appTenant);
      expect(CtxThing.isInsideBatchContext()).toBe(true);
      await CtxThing.create({ name: "a" });
      return "v";
    });
    expect(value).toBe("v");
    expect(capacity.write).toBeGreaterThan(0);
    expect(capacity.read).toBeGreaterThanOrEqual(0);
  });

  test("capacity is reported even when the work throws", async () => {
    const thrown = new Error("after a write");
    const r = await runInCall(appTenant, async () => {
      await CtxThing.create({ name: "b" });
      throw thrown;
    });
    expect(r.error).toBe(thrown);
    expect("value" in r).toBe(false);
    expect(r.capacity.write).toBeGreaterThan(0);
    expect(Object.keys(thrown)).not.toContain("capacity"); // the error is not mutated
  });

  test("two calls in flight do not share tenant, cache or capacity", async () => {
    const seed = await TenantContext.runWithTenant(appTenant, () =>
      CtxThing.create({ name: "seed" }),
    );
    const [a, b] = await Promise.all([
      runInCall(appTenant, async () => {
        await CtxThing.find(seed.thingId);
        await new Promise((r) => setTimeout(r, 20));
        return TenantContext.getCurrentTenant();
      }),
      runInCall(adminTenant, async () => {
        await CtxThing.create({ name: "admin side" });
        return TenantContext.getCurrentTenant();
      }),
    ]);
    expect(a.value).toBe(appTenant);
    expect(b.value).toBe(adminTenant);
    expect(a.capacity.write).toBe(0);
    expect(a.capacity.read).toBeGreaterThan(0);
    expect(b.capacity.write).toBeGreaterThan(0);
  });
});

describe("adminModels bound to the admin partition", () => {
  test("static and instance methods run in the partition from inside an app call", async () => {
    await runInCall(appTenant, async () => {
      const ctx = makeCtx({ scope: "both", adminModels: { CtxThing }, adminPartition: adminTenant });
      const { CtxThing: AdminThing } = ctx.adminModels;
      const row = await AdminThing.create({ name: "in admin" });
      expect(row).toBeInstanceOf(CtxThing);
      row.name = "renamed in admin";
      await row.save();
      const again = await AdminThing.find(row.thingId);
      expect(again.name).toBe("renamed in admin");
      // The app tenant does not see it.
      const appSide = await ctx.models.CtxThing.find(row.thingId, { bypassCache: true });
      expect(appSide.exists()).toBe(false);
      // The partition does.
      const stored = await TenantContext.runWithTenant(adminTenant, () =>
        CtxThing.find(row.thingId, { bypassCache: true }),
      );
      expect(stored.name).toBe("renamed in admin");
    });
  });

  test("related loads from an admin row stay in the partition", async () => {
    await runInCall(appTenant, async () => {
      const { CtxThing: AdminThing } = bindModelsToTenant({ CtxThing }, adminTenant);
      const parent = await AdminThing.create({ name: "parent" });
      const child = await AdminThing.create({ name: "child", parent: parent.thingId });
      const loaded = await (await AdminThing.find(child.thingId)).getOrLoadRelatedField("parent");
      expect(loaded.exists()).toBe(true);
      expect(loaded.name).toBe("parent");
    });
  });

  test("admin capacity counts toward the call", async () => {
    const { capacity } = await runInCall(appTenant, async () => {
      const { CtxThing: AdminThing } = bindModelsToTenant({ CtxThing }, adminTenant);
      await AdminThing.create({ name: "counted" });
    });
    expect(capacity.write).toBeGreaterThan(0);
  });

  test("a bound model keeps the base model's name and is cached per partition", () => {
    const a = bindModelsToTenant({ CtxThing }, adminTenant).CtxThing;
    const b = bindModelsToTenant({ CtxThing }, adminTenant).CtxThing;
    expect(a).toBe(b);
    expect(a.name).toBe("CtxThing");
    expect(a.prototype).toBeInstanceOf(CtxThing);
  });

  test("binding does not change the base model (no behavior change)", async () => {
    bindModelsToTenant({ CtxThing }, adminTenant);
    const row = await TenantContext.runWithTenant(appTenant, () =>
      CtxThing.create({ name: "base still ambient" }),
    );
    const stored = await TenantContext.runWithTenant(appTenant, () =>
      CtxThing.find(row.thingId, { bypassCache: true }),
    );
    expect(stored.exists()).toBe(true);
  });

  test("refuses an invalid partition id", () => {
    expect(() => bindModelsToTenant({ CtxThing }, "bad#id")).toThrow(/tenant/);
  });
});

describe("fresh", () => {
  test("merges the nested capacity into the outer call", async () => {
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(appTenant, async () => {
        const before = getBatchContextCapacity();
        let inner;
        await fresh(async () => {
          await CtxThing.create({ name: "fresh write" });
          inner = getBatchContextCapacity();
        });
        const after = getBatchContextCapacity();
        expect(inner.write).toBeGreaterThan(0);
        expect(after.write).toBeCloseTo(before.write + inner.write);
        expect(after.read).toBeCloseTo(before.read + inner.read);
      }),
    );
  });

  test("merges capacity even when the nested work throws", async () => {
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(appTenant, async () => {
        await expect(
          fresh(async () => {
            await CtxThing.create({ name: "then throw" });
            throw new Error("lost race");
          }),
        ).rejects.toThrow("lost race");
        expect(getBatchContextCapacity().write).toBeGreaterThan(0);
      }),
    );
  });

  test("reads in fresh bypass the outer cache", async () => {
    const row = await TenantContext.runWithTenant(appTenant, () =>
      CtxThing.create({ name: "v1" }),
    );
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(appTenant, async () => {
        expect((await CtxThing.find(row.thingId)).name).toBe("v1");
        // Someone else writes, outside this request.
        await runWithBatchContext(() => CtxThing.update(row.thingId, { name: "v2" }));
        expect((await CtxThing.find(row.thingId)).name).toBe("v1"); // cached
        expect((await fresh(() => CtxThing.find(row.thingId))).name).toBe("v2");
      }),
    );
  });

  test("primes the outer cache with rows the nested work wrote or read", async () => {
    const row = await TenantContext.runWithTenant(appTenant, () =>
      CtxThing.create({ name: "old" }),
    );
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(appTenant, async () => {
        expect((await CtxThing.find(row.thingId)).name).toBe("old");
        await fresh(() => CtxThing.update(row.thingId, { name: "new" }));
        const readsBefore = getBatchContextCapacity().read;
        const after = await CtxThing.find(row.thingId);
        expect(after.name).toBe("new");
        expect(getBatchContextCapacity().read).toBe(readsBefore); // served from cache
      }),
    );
  });

  test("a delete in fresh evicts the row from the outer cache", async () => {
    const row = await TenantContext.runWithTenant(appTenant, () =>
      CtxThing.create({ name: "doomed" }),
    );
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(appTenant, async () => {
        expect((await CtxThing.find(row.thingId)).exists()).toBe(true);
        await fresh(() => CtxThing.delete(row.thingId));
        expect((await CtxThing.find(row.thingId)).exists()).toBe(false);
      }),
    );
  });

  test("ctx.fresh is the same function", () => {
    expect(makeCtx().fresh).toBe(fresh);
  });

  test("outside any batch context fresh just runs the work in a new one", async () => {
    const value = await fresh(async () => CtxThing.isInsideBatchContext());
    expect(value).toBe(true);
  });
});
