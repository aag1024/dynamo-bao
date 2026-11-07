const dynamoBao = require("../../src");
const { TenantContext, runWithBatchContext, getBatchContextCapacity } = dynamoBao;
const testConfig = require("../config");
const { BaoModel, PrimaryKeyConfig } = require("../../src/model");
const { StringField, UlidField } = require("../../src/fields");
const { CodecError } = require("../../src/remote/codec");
const { defineProcedure, ProcedureRegistry } = require("../../src/remote/procedures");
const { createExecutor } = require("../../src/remote/executor");
const { remote, inProcess } = require("../../src/remote/client");
const {
  cleanupTestDataByIteration,
  initTestModelsWithTenant,
} = require("../utils/test-utils");
const { ulid } = require("ulid");

class ClThing extends BaoModel {
  static modelPrefix = "rclt";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = { thingId: UlidField({ autoAssign: true }), name: StringField() };
  static primaryKey = PrimaryKeyConfig("thingId");
}

let appA, appB;
beforeAll(() => {
  appA = ulid();
  appB = ulid();
  initTestModelsWithTenant(testConfig, appA).registerModel(ClThing);
  TenantContext.setDefaultTenant(null);
});
afterAll(async () => {
  await cleanupTestDataByIteration(appA, [ClThing]);
  await cleanupTestDataByIteration(appB, [ClThing]);
  TenantContext.reset();
});

const actorFor = (appId) => ({ kind: "system", appId, systemAuthority: false, preAuthenticated: false });

const create = defineProcedure({
  name: "thing.create",
  version: 1,
  scope: "app",
  replay: "needs-ledger",
  async run(ctx, { name }) {
    const row = await ctx.models.ClThing.create({ name });
    return { thingId: row.thingId };
  },
});
const get = defineProcedure({
  name: "thing.get",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run(ctx, { thingId }) {
    return ctx.models.ClThing.find(thingId); // a model instance, encoded by default
  },
});
const guarded = defineProcedure({
  name: "thing.guarded",
  version: 1,
  scope: "app",
  replay: "conditional",
  async run() {
    return "guarded";
  },
});
const boom = defineProcedure({
  name: "thing.boom",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run() {
    throw new Error("boom");
  },
});
const echoArgs = defineProcedure({
  name: "test.args",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run(ctx, args) {
    return { args, actor: ctx.actor, operationId: ctx.operationId, requestId: ctx.requestId };
  },
});

const SECRET = "binding-secret";
const executor = createExecutor({
  procedures: new ProcedureRegistry([create, get, guarded, boom, echoArgs]),
  context: () => ({ models: { ClThing } }),
  ingress: (req, env) => req.headers.get("x-data-binding") === env.SECRET,
});
const transport = () => inProcess(executor, { env: { SECRET }, headers: { "x-data-binding": SECRET } });

/** A transport that records requests and can fail on chosen attempts. */
function scripted(inner, script) {
  const sent = [];
  return {
    sent,
    async fetch(request) {
      const body = await request.clone().json();
      sent.push({ request, body });
      const step = script[sent.length - 1] ?? "pass";
      if (step === "throw") throw new TypeError("network connection lost");
      if (step === "502") return new Response("<html>bad gateway</html>", { status: 502 });
      if (step === "drop-call") {
        const res = await inner.fetch(request);
        const json = await res.json();
        json.calls = {};
        return Response.json(json);
      }
      return inner.fetch(request);
    },
  };
}

describe("round trip through the executor in process", () => {
  test("call returns an ok outcome with capacity and duration", async () => {
    const data = remote(transport(), { actor: actorFor(appA) });
    const r = await data.call(create, { name: "via client" }, { tenant: appA });
    expect(Object.keys(r).sort()).toEqual(["capacity", "ms", "ok", "placement"]);
    expect(r.ok.thingId).toEqual(expect.any(String));
    expect(r.capacity.write).toBeGreaterThan(0);

    const g = await data.call(get, { thingId: r.ok.thingId }, { tenant: appA });
    const row = ClThing.fromRemote(g.ok);
    expect(row.name).toBe("via client");
    expect(row.isDetached()).toBe(true);
  });

  test("an error outcome passes through with its name", async () => {
    const r = await remote(transport(), { actor: actorFor(appA) }).call(boom, {}, { tenant: appA });
    expect(r.error).toMatchObject({ name: "Error", message: "boom" });
    expect("ok" in r).toBe(false);
    expect("unknown" in r).toBe(false);
  });

  test("an envelope refusal becomes an error outcome for the call, marked refused", async () => {
    const t = inProcess(executor, { env: { SECRET }, headers: { "x-data-binding": "wrong" } });
    const r = await remote(t, { actor: actorFor(appA) }).call(guarded, {}, { tenant: appA });
    expect(r.error).toMatchObject({ name: "IngressRefused", refused: true });
  });

  test("args are encoded: a model instance crosses as { $model, data }", async () => {
    const row = ClThing._createFromDyItem({ thingId: "t1", name: "arg row" });
    const r = await remote(transport(), { actor: actorFor(appA) }).call(echoArgs, { row }, { tenant: appA });
    expect(r.ok.args.row).toEqual({ $model: "ClThing", data: { thingId: "t1", name: "arg row" } });
  });

  test("args that are not JSON are refused before anything is sent", async () => {
    const t = scripted(transport(), []);
    const data = remote(t, { actor: actorFor(appA) });
    await expect(data.call(echoArgs, { at: new Date() }, { tenant: appA })).rejects.toThrow(CodecError);
    expect(t.sent).toHaveLength(0);
  });

  test("the request is one POST of a v1 envelope with the descriptor's id and scope", async () => {
    const t = scripted(transport(), []);
    await remote(t, { actor: actorFor(appA), headers: { "x-extra": "1" } }).call(
      echoArgs,
      { a: 1 },
      { tenant: appA, operationId: "op-7", requestId: "rq-7" },
    );
    const { request, body } = t.sent[0];
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/_data/call");
    expect(request.headers.get("content-type")).toMatch(/application\/json/);
    expect(request.headers.get("x-extra")).toBe("1");
    expect(body).toEqual({
      v: 1,
      operationId: "op-7",
      requestId: "rq-7",
      actor: actorFor(appA),
      calls: [{ id: "c0", proc: "test.args@1", tenant: appA, scope: "app", args: { a: 1 } }],
    });
  });

  test("operationId defaults to a fresh ULID and reaches the procedure", async () => {
    const r = await remote(transport(), { actor: actorFor(appA) }).call(echoArgs, {}, { tenant: appA });
    expect(r.ok.operationId).toMatch(/^[0-9A-Z]{26}$/);
  });

  test("a per-call actor overrides the client's", async () => {
    const r = await remote(transport(), { actor: actorFor(appA) }).call(echoArgs, {}, {
      tenant: appB,
      actor: actorFor(appB),
    });
    expect(r.ok.actor).toEqual(actorFor(appB));
  });

  test("refuses a call without a descriptor, tenant or actor", async () => {
    const data = remote(transport(), { actor: actorFor(appA) });
    await expect(data.call({ id: "x@1" }, {}, { tenant: appA })).rejects.toThrow(/descriptor/);
    await expect(data.call(echoArgs, {}, {})).rejects.toThrow(/tenant/);
    await expect(remote(transport()).call(echoArgs, {}, { tenant: appA })).rejects.toThrow(/actor/);
  });

  test("remote refuses a transport without fetch", () => {
    expect(() => remote({}, {})).toThrow(/fetch/);
  });
});

describe("batch: several calls in one envelope", () => {
  test("two tenants, one round trip, outcomes by id", async () => {
    const t = scripted(transport(), []);
    const out = await remote(t, { actor: actorFor(appA) }).batch([
      { id: "a", procedure: create, args: { name: "A" }, tenant: appA },
      { id: "b", procedure: echoArgs, args: { n: 2 }, tenant: appB, actor: actorFor(appB) },
      { id: "c", procedure: boom, args: {}, tenant: appA },
    ]);
    expect(t.sent).toHaveLength(1);
    expect(out.a.ok.thingId).toEqual(expect.any(String));
    expect(out.b.ok.args).toEqual({ n: 2 });
    expect(out.c.error.message).toBe("boom");
  });

  test("ids default to the call's position", async () => {
    const out = await remote(transport(), { actor: actorFor(appA) }).batch([
      { procedure: guarded, args: {}, tenant: appA },
      { procedure: guarded, args: {}, tenant: appA },
    ]);
    expect(Object.keys(out)).toEqual(["c0", "c1"]);
  });

  test("refuses an empty batch", async () => {
    await expect(remote(transport(), { actor: actorFor(appA) }).batch([])).rejects.toThrow(/non-empty/);
  });

  test("refuses duplicate ids", async () => {
    await expect(
      remote(transport(), { actor: actorFor(appA) }).batch([
        { id: "x", procedure: guarded, tenant: appA },
        { id: "x", procedure: guarded, tenant: appA },
      ]),
    ).rejects.toThrow(/duplicate/);
  });
});

describe("transport failure", () => {
  test.each([
    ["the transport throws", "throw"],
    ["a 502 without an envelope", "502"],
    ["the response lacks the call", "drop-call"],
  ])("%s gives unknown", async (_label, step) => {
    const t = scripted(transport(), [step]);
    const r = await remote(t, { actor: actorFor(appA) }).call(guarded, {}, { tenant: appA });
    expect(r.unknown).toBe(true);
    expect(typeof r.reason).toBe("string");
    expect("ok" in r || "error" in r).toBe(false);
  });

  test.each([
    ["200 JSON that is not an envelope", () => Response.json({ hello: 1 })],
    ["a non-200 envelope without an error", () => Response.json({ v: 1 }, { status: 500 })],
    ["a 200 envelope without calls", () => Response.json({ v: 1 })],
  ])("%s gives unknown", async (_label, respond) => {
    const r = await remote({ fetch: async () => respond() }, { actor: actorFor(appA) }).call(guarded, {}, { tenant: appA });
    expect(r.unknown).toBe(true);
  });

  test("no resend by default", async () => {
    const t = scripted(transport(), ["throw"]);
    await remote(t, { actor: actorFor(appA) }).call(guarded, {}, { tenant: appA });
    expect(t.sent).toHaveLength(1);
  });

  test.each([["idempotent", get], ["conditional", guarded]])(
    "a %s call is resent with the same operationId when retries allow",
    async (_cls, proc) => {
      const t = scripted(transport(), ["throw", "502"]);
      const r = await remote(t, { actor: actorFor(appA), retries: 2 }).call(proc, { thingId: "none" }, { tenant: appA });
      expect("ok" in r).toBe(true);
      expect(t.sent).toHaveLength(3);
      expect(new Set(t.sent.map((s) => s.body.operationId)).size).toBe(1);
    },
  );

  test("retries run out into unknown", async () => {
    const t = scripted(transport(), ["throw", "throw"]);
    const r = await remote(t, { actor: actorFor(appA), retries: 1 }).call(guarded, {}, { tenant: appA });
    expect(r.unknown).toBe(true);
    expect(t.sent).toHaveLength(2);
  });

  test("a needs-ledger call is never resent automatically", async () => {
    const t = scripted(transport(), ["throw"]);
    const r = await remote(t, { actor: actorFor(appA), retries: 5 }).call(create, { name: "once" }, { tenant: appA });
    expect(r.unknown).toBe(true);
    expect(t.sent).toHaveLength(1);
  });

  test("a batch with any needs-ledger call is never resent", async () => {
    const t = scripted(transport(), ["throw"]);
    const out = await remote(t, { actor: actorFor(appA), retries: 5 }).batch([
      { id: "g", procedure: guarded, tenant: appA },
      { id: "c", procedure: create, args: { name: "x" }, tenant: appA },
    ]);
    expect(out.g.unknown).toBe(true);
    expect(out.c.unknown).toBe(true);
    expect(t.sent).toHaveLength(1);
  });

  test("an error outcome is not a transport failure and is not resent", async () => {
    const t = scripted(transport(), []);
    const r = await remote(t, { actor: actorFor(appA), retries: 3 }).call(boom, {}, { tenant: appA });
    expect(r.error).toBeDefined();
    expect(t.sent).toHaveLength(1);
  });
});

describe("capacity passthrough", () => {
  test("reported capacity is added to the caller's batch context", async () => {
    await runWithBatchContext(async () => {
      const before = getBatchContextCapacity();
      const r = await remote(transport(), { actor: actorFor(appA) }).call(create, { name: "cap" }, { tenant: appA });
      const after = getBatchContextCapacity();
      expect(after.write - before.write).toBeCloseTo(r.capacity.write);
      expect(after.read - before.read).toBeCloseTo(r.capacity.read);
    });
  });

  test("the executor's own DynamoDB work is not also counted in the caller's context", async () => {
    await runWithBatchContext(async () => {
      const r = await remote(transport(), { actor: actorFor(appA) }).call(create, { name: "once" }, { tenant: appA });
      expect(getBatchContextCapacity().write).toBeCloseTo(r.capacity.write);
    });
  });

  test("outside a batch context nothing is accumulated and nothing fails", async () => {
    const r = await remote(transport(), { actor: actorFor(appA) }).call(guarded, {}, { tenant: appA });
    expect(r.ok).toBe("guarded");
  });
});

describe("inProcess", () => {
  test("runs the executor with the given env and headers, through ingress", async () => {
    const seen = [];
    const ex = createExecutor({
      procedures: new ProcedureRegistry([guarded]),
      context: (call, env) => (seen.push(env), { models: {} }),
      ingress: (req, env) => req.headers.get("x-k") === env.K,
    });
    const ok = await remote(inProcess(ex, { env: { K: "v" }, headers: { "x-k": "v" } }), {
      actor: actorFor(appA),
    }).call(guarded, {}, { tenant: appA });
    expect(ok.ok).toBe("guarded");
    expect(seen).toEqual([{ K: "v" }]);
    const refused = await remote(inProcess(ex, { env: { K: "v" } }), { actor: actorFor(appA) }).call(guarded, {}, {
      tenant: appA,
    });
    expect(refused.error.name).toBe("IngressRefused");
  });

  test("the procedure runs in its own tenant and batch context, not the caller's", async () => {
    const seen = {};
    const where = defineProcedure({
      name: "test.where",
      version: 1,
      scope: "app",
      replay: "idempotent",
      async run(ctx) {
        seen.tenant = TenantContext.getCurrentTenant();
        seen.capacity = getBatchContextCapacity();
        return null;
      },
    });
    const ex = createExecutor({
      procedures: new ProcedureRegistry([where]),
      context: () => ({ models: {} }),
      ingress: () => true,
    });
    await TenantContext.runWithTenant("caller-tenant", () =>
      runWithBatchContext(async () => {
        await remote(inProcess(ex), { actor: actorFor(appA) }).call(where, {}, { tenant: appA });
      }),
    );
    expect(seen.tenant).toBe(appA);
    expect(seen.capacity).toEqual({ read: 0, write: 0 });
  });

  test("refuses something that is not an executor", () => {
    expect(() => inProcess({})).toThrow(/executor/);
  });
});

describe("call ids", () => {
  test("a batch id of __proto__ keeps its outcome", async () => {
    const out = await remote(transport(), { actor: actorFor(appA) }).batch([
      { id: "__proto__", procedure: echoArgs, args: { n: 1 }, tenant: appA },
    ]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__").value.ok.args).toEqual({ n: 1 });
  });

  test("a response without the __proto__ outcome reports it unknown", async () => {
    const t = scripted(transport(), ["drop-call"]);
    const out = await remote(t, { actor: actorFor(appA) }).batch([
      { id: "__proto__", procedure: echoArgs, args: {}, tenant: appA },
    ]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__").value).toEqual({
      unknown: true,
      reason: "the response has no outcome for this call",
    });
  });
});

describe("placement", () => {
  /** A transport that gives the executor a Cloudflare request object, as a service binding does. */
  const fromColo = (colo) => ({
    fetch(request) {
      const req = new Request(request);
      Object.defineProperty(req, "cf", { value: { colo } });
      return executor.fetch(req, { SECRET });
    },
  });
  const headers = { "x-data-binding": SECRET };

  test("ok and error outcomes carry the executor's placement", async () => {
    const data = remote(fromColo("SEA"), { actor: actorFor(appA), headers });
    const ok = await data.call(echoArgs, { n: 1 }, { tenant: appA });
    expect(ok.placement).toEqual({ colo: "SEA", region: null });
    const failed = await data.call(boom, {}, { tenant: appA });
    expect(failed.error.message).toBe("boom");
    expect(failed.placement).toEqual({ colo: "SEA", region: null });
  });

  test("every outcome in a batch carries it", async () => {
    const out = await remote(fromColo("SJC"), { actor: actorFor(appA), headers }).batch([
      { id: "a", procedure: echoArgs, args: {}, tenant: appA },
      { id: "b", procedure: boom, args: {}, tenant: appA },
    ]);
    expect(out.a.placement).toEqual({ colo: "SJC", region: null });
    expect(out.b.placement).toEqual({ colo: "SJC", region: null });
  });

  test("a response without placement gives outcomes without it", async () => {
    const bare = {
      async fetch(request) {
        const json = await (await executor.fetch(request, { SECRET })).json();
        delete json.placement;
        return Response.json(json);
      },
    };
    const r = await remote(bare, { actor: actorFor(appA), headers }).call(echoArgs, {}, { tenant: appA });
    expect(r.ok).toBeDefined();
    expect("placement" in r).toBe(false);
  });

  test("in process there is no colo", async () => {
    const r = await remote(transport(), { actor: actorFor(appA) }).call(echoArgs, {}, { tenant: appA });
    expect(r.placement).toEqual({ colo: null, region: null });
  });

  test("unknown and envelope-refusal outcomes have none: no executor answered for the call", async () => {
    const lost = await remote({ fetch: () => Promise.reject(new Error("gone")) }, { actor: actorFor(appA) }).call(
      echoArgs, {}, { tenant: appA },
    );
    expect("placement" in lost).toBe(false);
    const refused = await remote(inProcess(executor, { env: { SECRET } }), { actor: actorFor(appA) }).call(
      echoArgs, {}, { tenant: appA },
    );
    expect(refused.error.name).toBe("IngressRefused");
    expect("placement" in refused).toBe(false);
  });
});
