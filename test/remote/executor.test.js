const dynamoBao = require("../../src");
const { TenantContext } = dynamoBao;
const testConfig = require("../config");
const { BaoModel, PrimaryKeyConfig } = require("../../src/model");
const { StringField, UlidField, DateTimeField } = require("../../src/fields");
const { ConditionalError } = require("../../src/exceptions");
const { getBatchContextStore } = require("../../src/mixins/batch-loading-mixin");
const { defineProcedure, ProcedureRegistry } = require("../../src/remote/procedures");
const { createExecutor } = require("../../src/remote/executor");
const {
  cleanupTestDataByIteration,
  initTestModelsWithTenant,
} = require("../utils/test-utils");
const { ulid } = require("ulid");

class ExThing extends BaoModel {
  static modelPrefix = "rexe";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    thingId: UlidField({ autoAssign: true }),
    name: StringField(),
    when: DateTimeField(),
  };
  static primaryKey = PrimaryKeyConfig("thingId");
}

let appA, appB, adminPartition;

beforeAll(() => {
  appA = ulid();
  appB = ulid();
  adminPartition = `${appA}-admin`;
  const manager = initTestModelsWithTenant(testConfig, appA);
  manager.registerModel(ExThing);
  TenantContext.setDefaultTenant(null);
});

afterAll(async () => {
  for (const t of [appA, appB, adminPartition]) {
    await cleanupTestDataByIteration(t, [ExThing]);
  }
  TenantContext.reset();
});

const actorFor = (appId, extra = {}) => ({
  kind: "system",
  appId,
  systemAuthority: false,
  preAuthenticated: false,
  ...extra,
});

const echo = defineProcedure({
  name: "test.echo",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run(ctx, args) {
    return { args, tenant: ctx.tenant, actor: ctx.actor };
  },
});

const create = defineProcedure({
  name: "thing.create",
  version: 1,
  scope: "app",
  replay: "needs-ledger",
  async run(ctx, { name }) {
    const row = await ctx.models.ExThing.create({ name });
    return { thingId: row.thingId, tenant: ctx.tenant };
  },
});

const read = defineProcedure({
  name: "thing.read",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run(ctx, { thingId }) {
    const row = await ctx.models.ExThing.find(thingId);
    return row.exists() ? { name: row.name } : null;
  },
});

const fail = defineProcedure({
  name: "test.fail",
  version: 1,
  scope: "app",
  replay: "conditional",
  async run(ctx, { kind }) {
    if (kind === "conditional") throw new ConditionalError("guard failed", "x");
    if (kind === "aws") {
      const e = new Error("Throughput exceeds the current capacity");
      e.name = "ProvisionedThroughputExceededException";
      e.$metadata = { httpStatusCode: 400 };
      throw e;
    }
    if (kind === "string") throw "just a string";
    if (kind === "after-write") {
      await ctx.models.ExThing.create({ name: "written then thrown" });
      throw new Error("failed after a write");
    }
    const e = new Error("plain failure");
    e.code = "E_PLAIN";
    throw e;
  },
});

const versioned = [1, 2].map((version) =>
  defineProcedure({
    name: "test.versioned",
    version,
    scope: "app",
    replay: "idempotent",
    async run() {
      return { servedBy: version };
    },
  }),
);

const adminWrite = defineProcedure({
  name: "admin.write",
  version: 1,
  scope: "admin",
  replay: "needs-ledger",
  async run(ctx, { name }) {
    const row = await ctx.adminModels.ExThing.create({ name });
    return { thingId: row.thingId, sawModels: ctx.models.ExThing.name };
  },
});

let lastRun = {};
const probe = defineProcedure({
  name: "test.probe",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run(ctx) {
    lastRun = { ctx, store: getBatchContextStore(), tenant: TenantContext.getCurrentTenant() };
    return { now: ctx.now(), config: ctx.config, requestId: ctx.requestId, operationId: ctx.operationId };
  },
});

const returnsRow = defineProcedure({
  name: "test.returnsRow",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run(ctx, { encode }) {
    const row = await ctx.models.ExThing.create({ name: "row", when: new Date(5) });
    if (encode) return { row: require("../../src/remote/codec").encodeValue(row) };
    return { row };
  },
});

const returnsDate = defineProcedure({
  name: "test.returnsDate",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run() {
    return { resetAt: new Date() };
  },
});

const big = defineProcedure({
  name: "test.big",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run(ctx, { bytes }) {
    return "x".repeat(bytes);
  },
});

const deferred = defineProcedure({
  name: "test.deferred",
  version: 1,
  scope: "app",
  replay: "needs-ledger",
  async run(ctx, { ms }) {
    ctx.waitUntil(new Promise((r) => setTimeout(() => ((deferredDone = true), r()), ms)));
    return "responded";
  },
});
let deferredDone = false;

const barrier = (() => {
  let arrived = 0;
  let release;
  const all = new Promise((r) => (release = r));
  return {
    reset() {
      arrived = 0;
    },
    proc: defineProcedure({
      name: "test.barrier",
      version: 1,
      scope: "app",
      replay: "idempotent",
      async run() {
        arrived += 1;
        if (arrived === 2) release();
        await Promise.race([
          all,
          new Promise((_, rej) => setTimeout(() => rej(new Error("calls ran one at a time")), 2000)),
        ]);
        return arrived;
      },
    }),
  };
})();

const registry = new ProcedureRegistry([
  echo,
  create,
  read,
  fail,
  ...versioned,
  adminWrite,
  probe,
  returnsRow,
  returnsDate,
  big,
  deferred,
  barrier.proc,
]);

const resolverCalls = [];
function resolver(call, env) {
  resolverCalls.push({ call, env });
  if (env?.failResolver) throw new Error("resolver exploded");
  return {
    models: { ExThing },
    adminModels: call.scope === "app" ? undefined : env?.noAdmin ? undefined : { ExThing },
    adminPartition,
    config: { FLAG: "on" },
  };
}

const SECRET = "s3cret";
function makeExecutor(overrides = {}) {
  return createExecutor({
    procedures: registry,
    context: resolver,
    ingress: (request, env) => request.headers.get("x-data-binding") === env.SECRET,
    region: "aws:us-west-2",
    ...overrides,
  });
}
const ENV = { SECRET };

function request(body, { headers = {}, method = "POST", cf } = {}) {
  const req = new Request("https://data.internal/_data/call", {
    method,
    headers: { "content-type": "application/json", "x-data-binding": SECRET, ...headers },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  if (cf) Object.defineProperty(req, "cf", { value: cf });
  return req;
}

function envelope(calls, extra = {}) {
  return { v: 1, operationId: "op-1", actor: actorFor(appA), calls, ...extra };
}

async function send(executor, body, opts) {
  const res = await executor.fetch(request(body, opts), opts?.env ?? ENV, opts?.execCtx);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

describe("createExecutor options", () => {
  test("requires a registry, a context resolver and an ingress check", () => {
    expect(() => createExecutor({ context: resolver, ingress: () => true })).toThrow(/procedures/);
    expect(() => createExecutor({ procedures: registry, ingress: () => true })).toThrow(/context/);
    expect(() => createExecutor({ procedures: registry, context: resolver })).toThrow(/ingress/);
  });

  test("defaults the budget to 8 calls and 1 MB each way", () => {
    expect(makeExecutor().budget).toEqual({
      maxCalls: 8,
      maxRequestBytes: 1_000_000,
      maxResponseBytes: 1_000_000,
    });
  });
});

describe("ingress", () => {
  test("refuses a request the ingress check rejects, before reading it", async () => {
    const r = await send(makeExecutor(), "not even json", { headers: { "x-data-binding": "wrong" } });
    expect(r.status).toBe(403);
    expect(r.body.error.name).toBe("IngressRefused");
  });

  test("refuses when the ingress check throws", async () => {
    const r = await send(makeExecutor({ ingress: () => { throw new Error("x"); } }), envelope([]));
    expect(r.status).toBe(403);
  });

  test("supports an async ingress check and passes request and env", async () => {
    const seen = [];
    const executor = makeExecutor({
      ingress: async (req, env) => (seen.push([req.method, env]), true),
    });
    const r = await send(executor, envelope([{ id: "a", proc: "test.echo@1", tenant: appA }]));
    expect(r.status).toBe(200);
    expect(seen).toEqual([["POST", ENV]]);
  });

  test("refuses methods other than POST", async () => {
    const r = await send(makeExecutor(), null, { method: "GET" });
    expect(r.status).toBe(405);
  });
});

describe("envelope validation", () => {
  const call = () => ({ id: "a", proc: "test.echo@1", tenant: appA });

  test.each([
    ["malformed JSON", "{", 400, "EnvelopeError"],
    ["a non-object body", "[1]", 400, "EnvelopeError"],
    ["no protocol version", { operationId: "o", actor: {}, calls: [] }, 400, "UnsupportedVersion"],
    ["protocol version 2", { v: 2, operationId: "o", calls: [] }, 400, "UnsupportedVersion"],
    ["no operationId", { v: 1, actor: actorFor("x"), calls: [{ id: "a", proc: "p@1", tenant: "x" }] }, 400, "EnvelopeError"],
    ["no calls", { v: 1, operationId: "o", actor: actorFor("x"), calls: [] }, 400, "EnvelopeError"],
    ["calls not an array", { v: 1, operationId: "o", actor: actorFor("x"), calls: {} }, 400, "EnvelopeError"],
  ])("refuses %s", async (_label, body, status, name) => {
    const r = await send(makeExecutor(), body);
    expect(r.status).toBe(status);
    expect(r.body.v).toBe(1);
    expect(r.body.error.name).toBe(name);
  });

  test.each([
    ["a call without an id", { proc: "test.echo@1", tenant: "t" }, /calls\[0\]\.id/],
    ["a call without a procedure", { id: "a", tenant: "t" }, /calls\[0\]\.proc/],
    ["a call without a tenant", { id: "a", proc: "test.echo@1" }, /calls\[0\]\.tenant/],
    ["a tenant that could forge keys", { id: "a", proc: "test.echo@1", tenant: "t#x" }, /calls\[0\]\.tenant/],
    ["an actor that is not an object", { id: "a", proc: "test.echo@1", tenant: "t", actor: "me" }, /calls\[0\]\.actor/],
    ["a scope that is not a string", { id: "a", proc: "test.echo@1", tenant: "t", scope: 3 }, /calls\[0\]\.scope/],
  ])("refuses %s, naming it", async (_label, c, pattern) => {
    const r = await send(makeExecutor(), envelope([c]));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(pattern);
  });

  test.each([
    ["an empty requestId", { requestId: "" }, /requestId/],
    ["an envelope actor that is not an object", { actor: "me" }, /actor must be an object/],
  ])("refuses %s", async (_label, extra, pattern) => {
    const r = await send(makeExecutor(), envelope([call()], extra));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(pattern);
  });

  test("refuses a call that is not an object", async () => {
    const r = await send(makeExecutor(), envelope(["nope"]));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/calls\[0\] must be an object/);
  });

  test("a body that cannot be read is a 400, not a crash", async () => {
    const broken = {
      method: "POST",
      headers: new Headers({ "x-data-binding": SECRET }),
      text: () => Promise.reject(new Error("stream torn")),
    };
    const res = await makeExecutor().fetch(broken, ENV);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/could not be read/);
  });

  test("refuses duplicate call ids", async () => {
    const r = await send(makeExecutor(), envelope([call(), call()]));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/duplicate call id "a"/);
  });

  test("refuses a call with no actor at either level", async () => {
    const r = await send(makeExecutor(), { v: 1, operationId: "o", calls: [call()] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/actor/);
  });

  test("args that are not JSON never arrive, and absent args are null", async () => {
    const r = await send(makeExecutor(), envelope([call()]));
    expect(r.body.calls.a.ok.args).toBeNull();
  });

  test("ignores envelope keys it does not know", async () => {
    const r = await send(makeExecutor(), envelope([call()], { future: true }));
    expect(r.status).toBe(200);
  });
});

describe("budget", () => {
  test("refuses more calls than maxCalls", async () => {
    const calls = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, proc: "test.echo@1", tenant: appA }));
    const r = await send(makeExecutor({ budget: { maxCalls: 2 } }), envelope(calls));
    expect(r.status).toBe(413);
    expect(r.body.error.name).toBe("BudgetExceeded");
    expect(r.body.error.message).toMatch(/3 calls.*2/);
  });

  test("refuses a request body over maxRequestBytes", async () => {
    const body = envelope([{ id: "a", proc: "test.echo@1", tenant: appA, args: "y".repeat(500) }]);
    const r = await send(makeExecutor({ budget: { maxRequestBytes: 200 } }), body);
    expect(r.status).toBe(413);
    expect(r.body.error.name).toBe("BudgetExceeded");
  });

  test("a result over maxResponseBytes becomes ResponseTooLarge; the others survive", async () => {
    const executor = makeExecutor({ budget: { maxResponseBytes: 2_000 } });
    const r = await send(
      executor,
      envelope([
        { id: "big", proc: "test.big@1", tenant: appA, args: { bytes: 5_000 } },
        { id: "small", proc: "test.big@1", tenant: appA, args: { bytes: 10 } },
      ]),
    );
    expect(r.status).toBe(200);
    expect(r.body.calls.big.error).toMatchObject({ name: "ResponseTooLarge", executed: true });
    expect(r.body.calls.small.ok).toBe("x".repeat(10));
    expect(JSON.stringify(r.body).length).toBeLessThanOrEqual(2_000);
  });
});

describe("dispatch refusals", () => {
  test("an unknown procedure is refused per call, naming the versions served", async () => {
    const r = await send(
      makeExecutor(),
      envelope([
        { id: "gone", proc: "test.versioned@3", tenant: appA },
        { id: "ok", proc: "test.echo@1", tenant: appA },
      ]),
    );
    expect(r.body.calls.gone.error).toMatchObject({ name: "UnknownProcedure", refused: true });
    expect(r.body.calls.gone.error.message).toMatch(/test\.versioned@3.*1, 2/);
    expect(r.body.calls.ok.ok).toBeDefined();
  });

  test("a call whose declared scope disagrees with the registry is refused", async () => {
    const r = await send(makeExecutor(), envelope([{ id: "a", proc: "test.echo@1", tenant: appA, scope: "admin" }]));
    expect(r.body.calls.a.error).toMatchObject({ name: "ScopeError", refused: true });
  });

  test("an admin-scope procedure is refused when the resolver gives no admin models", async () => {
    const r = await send(
      makeExecutor(),
      envelope([{ id: "a", proc: "admin.write@1", tenant: appA, args: { name: "n" } }]),
      { env: { ...ENV, noAdmin: true } },
    );
    expect(r.body.calls.a.error).toMatchObject({ name: "ScopeError", refused: true });
  });

  test("an actor whose app is not the call tenant is refused and the procedure never runs", async () => {
    lastRun = {};
    const r = await send(
      makeExecutor(),
      envelope([{ id: "a", proc: "test.probe@1", tenant: appB }]), // envelope actor is appA
    );
    expect(r.body.calls.a.error).toMatchObject({ name: "ActorTenantMismatch", refused: true });
    expect(lastRun).toEqual({});
  });

  test("a resolver that returns no models is refused", async () => {
    const executor = makeExecutor({ context: () => ({}) });
    const r = await send(executor, envelope([{ id: "a", proc: "test.echo@1", tenant: appA }]));
    expect(r.body.calls.a.error).toMatchObject({ name: "TypeError", refused: true });
    expect(r.body.calls.a.error.message).toMatch(/no models for test\.echo@1/);
  });

  test("a resolver failure is reported for that call only, as refused", async () => {
    const r = await send(makeExecutor(), envelope([{ id: "a", proc: "test.echo@1", tenant: appA }]), {
      env: { ...ENV, failResolver: true },
    });
    expect(r.body.calls.a.error).toMatchObject({ name: "Error", message: "resolver exploded", refused: true });
  });
});

describe("actor", () => {
  test("a per-call actor overrides the envelope actor", async () => {
    const r = await send(
      makeExecutor(),
      envelope([{ id: "b", proc: "test.echo@1", tenant: appB, actor: actorFor(appB, { kind: "user", userId: "u1" }) }]),
    );
    expect(r.body.calls.b.ok.actor).toEqual(actorFor(appB, { kind: "user", userId: "u1" }));
  });

  test("the executor reads only appId: every other actor field passes through and changes nothing", async () => {
    const variants = [
      actorFor(appA),
      actorFor(appA, { kind: "user", userId: "u" }),
      actorFor(appA, { kind: "admin", adminPartition: "adm" }),
      actorFor(appA, { systemAuthority: true }),
      actorFor(appA, { preAuthenticated: true }),
      actorFor(appA, { kind: "not-a-kind", systemAuthority: "yes", extra: [1] }),
      { appId: appA },
    ];
    const outcomes = [];
    for (const actor of variants) {
      resolverCalls.length = 0;
      const r = await send(makeExecutor(), envelope([{ id: "a", proc: "test.echo@1", tenant: appA, args: { n: 1 } }], { actor }));
      expect(r.status).toBe(200);
      expect(r.body.calls.a.ok.actor).toEqual(actor);
      expect(resolverCalls[0].call.actor).toEqual(actor);
      const { actor: _a, ...rest } = r.body.calls.a.ok;
      outcomes.push(rest);
    }
    for (const o of outcomes) expect(o).toEqual(outcomes[0]);
  });

  test("the executor source never reads an actor field other than appId", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "../../src/remote");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const reads = [...src.matchAll(/actor\??\.(\w+)/g)].map((m) => m[1]);
      expect({ file, reads: reads.filter((f) => f !== "appId") }).toEqual({ file, reads: [] });
      expect(src).not.toMatch(/actor\s*\[/);
    }
  });
});

describe("outcomes", () => {
  test("ok carries the value, per-call capacity and duration", async () => {
    const r = await send(makeExecutor(), envelope([{ id: "a", proc: "thing.create@1", tenant: appA, args: { name: "n" } }]));
    const a = r.body.calls.a;
    expect(a.ok).toEqual({ thingId: expect.any(String), tenant: appA });
    expect(a.capacity.write).toBeGreaterThan(0);
    expect(typeof a.capacity.read).toBe("number");
    expect(typeof a.ms).toBe("number");
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
  });

  test.each([
    ["an application error keeps its name and code", "conditional", { name: "ConditionalError", message: "guard failed" }],
    ["a plain error keeps message and code", "plain", { name: "Error", message: "plain failure", code: "E_PLAIN" }],
    ["an AWS error is marked infrastructure", "aws", { name: "ProvisionedThroughputExceededException", infrastructure: true, httpStatusCode: 400 }],
    ["a thrown non-Error is reported as Error", "string", { name: "Error", message: "just a string" }],
  ])("%s", async (_label, kind, expected) => {
    const r = await send(makeExecutor(), envelope([{ id: "a", proc: "test.fail@1", tenant: appA, args: { kind } }]));
    expect(r.body.calls.a.error).toMatchObject(expected);
    expect(r.body.calls.a.error.stack).toBeUndefined();
    expect(r.body.calls.a.error.refused).toBeUndefined();
    expect("ok" in r.body.calls.a).toBe(false);
  });

  test("a procedure cannot claim refused: only the executor marks an error refused", async () => {
    const liar = defineProcedure({
      name: "test.liar",
      version: 1,
      scope: "app",
      replay: "needs-ledger",
      async run(ctx) {
        await ctx.models.ExThing.create({ name: "wrote before lying" });
        throw Object.assign(new Error("pretend nothing ran"), { refused: true });
      },
    });
    const r = await send(
      makeExecutor({ procedures: new ProcedureRegistry([liar]) }),
      envelope([{ id: "a", proc: "test.liar@1", tenant: appA }]),
    );
    expect(r.body.calls.a.error.message).toBe("pretend nothing ran");
    expect(r.body.calls.a.error.refused).toBeUndefined();
  });

  test("a resolver that throws a non-Error is still reported as refused", async () => {
    const r = await send(
      makeExecutor({ context: () => { throw "no models today"; } }),
      envelope([{ id: "a", proc: "test.echo@1", tenant: appA }]),
    );
    expect(r.body.calls.a.error).toEqual({ name: "Error", message: "no models today", refused: true });
  });

  test("a failed call still reports the capacity it used", async () => {
    const r = await send(makeExecutor(), envelope([{ id: "a", proc: "test.fail@1", tenant: appA, args: { kind: "after-write" } }]));
    expect(r.body.calls.a.error.message).toBe("failed after a write");
    expect(r.body.calls.a.capacity.write).toBeGreaterThan(0);
  });

  test("the executor never produces unknown", async () => {
    const r = await send(makeExecutor(), envelope([{ id: "a", proc: "test.fail@1", tenant: appA, args: { kind: "aws" } }]));
    expect(JSON.stringify(r.body)).not.toMatch(/"unknown"/);
  });

  test("echoes placement: the colo the request ran in and the configured region", async () => {
    const r = await send(makeExecutor(), envelope([{ id: "a", proc: "test.echo@1", tenant: appA }]), { cf: { colo: "SEA" } });
    expect(r.body.placement).toEqual({ colo: "SEA", region: "aws:us-west-2" });
    const r2 = await send(makeExecutor({ region: undefined }), envelope([{ id: "a", proc: "test.echo@1", tenant: appA }]));
    expect(r2.body.placement).toEqual({ colo: null, region: null });
  });

  test("serves the previous version beside the current one", async () => {
    const r = await send(
      makeExecutor(),
      envelope([
        { id: "v1", proc: "test.versioned@1", tenant: appA },
        { id: "v2", proc: "test.versioned@2", tenant: appA },
      ]),
    );
    expect(r.body.calls.v1.ok).toEqual({ servedBy: 1 });
    expect(r.body.calls.v2.ok).toEqual({ servedBy: 2 });
  });
});

describe("plain-view return rule", () => {
  test("a model instance in a result is encoded as { $model, data } by default", async () => {
    const r = await send(makeExecutor(), envelope([{ id: "a", proc: "test.returnsRow@1", tenant: appA, args: {} }]));
    expect(r.body.calls.a.ok.row).toMatchObject({ $model: "ExThing", data: { name: "row", when: 5 } });
  });

  test("with plainReturns a model instance in a result is an error", async () => {
    const r = await send(
      makeExecutor({ plainReturns: true }),
      envelope([{ id: "a", proc: "test.returnsRow@1", tenant: appA, args: {} }]),
    );
    expect(r.body.calls.a.error).toMatchObject({ name: "CodecError" });
    expect(r.body.calls.a.error.message).toMatch(/\$\.row.*ExThing/);
  });

  test("with plainReturns an explicitly encoded row passes", async () => {
    const r = await send(
      makeExecutor({ plainReturns: true }),
      envelope([{ id: "a", proc: "test.returnsRow@1", tenant: appA, args: { encode: true } }]),
    );
    expect(r.body.calls.a.ok.row.$model).toBe("ExThing");
  });

  test("a Date in a result is always an error", async () => {
    const r = await send(makeExecutor(), envelope([{ id: "a", proc: "test.returnsDate@1", tenant: appA }]));
    expect(r.body.calls.a.error).toMatchObject({ name: "CodecError" });
    expect(r.body.calls.a.error.message).toMatch(/\$\.resetAt.*Date.*epoch milliseconds/);
  });
});

describe("multiple calls per envelope", () => {
  test("run concurrently", async () => {
    barrier.reset();
    const r = await send(
      makeExecutor(),
      envelope([
        { id: "a", proc: "test.barrier@1", tenant: appA },
        { id: "b", proc: "test.barrier@1", tenant: appA },
      ]),
    );
    expect(r.body.calls.a.ok).toBe(2);
    expect(r.body.calls.b.ok).toBe(2);
  });

  test("a throw in one call does not affect another", async () => {
    const r = await send(
      makeExecutor(),
      envelope([
        { id: "bad", proc: "test.fail@1", tenant: appA, args: { kind: "plain" } },
        { id: "good", proc: "thing.create@1", tenant: appA, args: { name: "survivor" } },
      ]),
    );
    expect(r.body.calls.bad.error.message).toBe("plain failure");
    expect(r.body.calls.good.ok.tenant).toBe(appA);
  });

  test("each call has its own tenant, batch context and capacity", async () => {
    const seen = [];
    const spy = defineProcedure({
      name: "test.spy",
      version: 1,
      scope: "app",
      replay: "idempotent",
      async run(ctx, { write }) {
        if (write) await ctx.models.ExThing.create({ name: "spy" });
        seen.push({ tenant: TenantContext.getCurrentTenant(), store: getBatchContextStore() });
        return ctx.tenant;
      },
    });
    const executor = makeExecutor({ procedures: new ProcedureRegistry([spy]) });
    const r = await send(
      executor,
      envelope([
        { id: "a", proc: "test.spy@1", tenant: appA, args: { write: true } },
        { id: "b", proc: "test.spy@1", tenant: appB, actor: actorFor(appB), args: { write: false } },
      ]),
    );
    expect(r.body.calls.a.ok).toBe(appA);
    expect(r.body.calls.b.ok).toBe(appB);
    expect(new Set(seen.map((s) => s.tenant))).toEqual(new Set([appA, appB]));
    expect(seen[0].store).not.toBe(seen[1].store);
    expect(r.body.calls.a.capacity.write).toBeGreaterThan(0);
    expect(r.body.calls.b.capacity.write).toBe(0);
  });

  test("a row written in one call is not visible through the other call's cache", async () => {
    const r1 = await send(makeExecutor(), envelope([{ id: "c", proc: "thing.create@1", tenant: appA, args: { name: "x" } }]));
    const thingId = r1.body.calls.c.ok.thingId;
    const r = await send(
      makeExecutor(),
      envelope([
        { id: "same", proc: "thing.read@1", tenant: appA, args: { thingId } },
        { id: "other", proc: "thing.read@1", tenant: appB, actor: actorFor(appB), args: { thingId } },
      ]),
    );
    expect(r.body.calls.same.ok).toEqual({ name: "x" });
    expect(r.body.calls.other.ok).toBeNull();
  });
});

describe("context wiring", () => {
  test("the resolver receives the call and env; its config reaches ctx", async () => {
    resolverCalls.length = 0;
    const r = await send(
      makeExecutor({ now: () => 42 }),
      envelope([{ id: "p", proc: "test.probe@1", tenant: appA }], { requestId: "rq-9" }),
    );
    expect(r.body.calls.p.ok).toEqual({ now: 42, config: { FLAG: "on" }, requestId: "rq-9", operationId: "op-1" });
    expect(resolverCalls[0].env).toBe(ENV);
    expect(resolverCalls[0].call).toEqual({
      id: "p",
      proc: "test.probe@1",
      name: "test.probe",
      version: 1,
      tenant: appA,
      scope: "app",
      replay: "idempotent",
      actor: actorFor(appA),
      requestId: "rq-9",
      operationId: "op-1",
    });
    expect(lastRun.tenant).toBe(appA);
    expect(lastRun.ctx.adminModels).toBeUndefined();
  });

  test("a requestId is generated when the envelope has none", async () => {
    const r = await send(makeExecutor(), envelope([{ id: "p", proc: "test.probe@1", tenant: appA }]));
    expect(r.body.calls.p.ok.requestId).toMatch(/^[0-9A-Z]{26}$/);
  });

  test("the logger is bound to the request id and call tenant", async () => {
    const lines = [];
    const logged = defineProcedure({
      name: "test.log",
      version: 1,
      scope: "app",
      replay: "idempotent",
      async run(ctx) {
        ctx.logger.info("inside", { k: 1 });
        return null;
      },
    });
    const executor = makeExecutor({
      procedures: new ProcedureRegistry([logged]),
      logger: { debug() {}, info: (m, d) => lines.push([m, d]), warn() {}, error() {} },
    });
    await send(executor, envelope([{ id: "l", proc: "test.log@1", tenant: appA }], { requestId: "rq-1" }));
    expect(lines).toEqual([["inside", { requestId: "rq-1", tenant: appA, k: 1 }]]);
  });

  test("admin-scope procedures write through adminModels into the resolver's partition", async () => {
    const r = await send(makeExecutor(), envelope([{ id: "a", proc: "admin.write@1", tenant: appA, args: { name: "adm" } }]));
    expect(r.body.calls.a.ok.sawModels).toBe("ExThing");
    const { thingId } = r.body.calls.a.ok;
    const inPartition = await TenantContext.runWithTenant(adminPartition, () =>
      ExThing.find(thingId, { bypassCache: true }),
    );
    const inApp = await TenantContext.runWithTenant(appA, () => ExThing.find(thingId, { bypassCache: true }));
    expect(inPartition.name).toBe("adm");
    expect(inApp.exists()).toBe(false);
  });
});

describe("waitUntil", () => {
  test("deferred work is handed to the platform and does not delay the response", async () => {
    deferredDone = false;
    const handed = [];
    const executor = makeExecutor();
    const r = await send(executor, envelope([{ id: "d", proc: "test.deferred@1", tenant: appA, args: { ms: 50 } }]), {
      execCtx: { waitUntil: (p) => handed.push(p) },
    });
    expect(r.body.calls.d.ok).toBe("responded");
    expect(deferredDone).toBe(false);
    expect(handed).toHaveLength(1);
    await Promise.all(handed);
    expect(deferredDone).toBe(true);
  });

  test("drain() awaits deferred work when there is no platform context", async () => {
    deferredDone = false;
    const executor = makeExecutor();
    await send(executor, envelope([{ id: "d", proc: "test.deferred@1", tenant: appA, args: { ms: 30 } }]));
    expect(deferredDone).toBe(false);
    await executor.drain();
    expect(deferredDone).toBe(true);
  });
});

describe("call ids and byte budgets", () => {
  test("a call id of __proto__ keeps its outcome", async () => {
    const r = await send(
      makeExecutor(),
      envelope([{ id: "__proto__", proc: "test.echo@1", tenant: appA, args: { n: 1 } }]),
    );
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.calls)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(r.body.calls, "__proto__").value.ok.args).toEqual({ n: 1 });
  });

  test("maxRequestBytes counts UTF-8 bytes, not characters", async () => {
    const body = envelope([{ id: "a", proc: "test.echo@1", tenant: appA, args: "é".repeat(300) }]);
    const text = JSON.stringify(body);
    const limit = text.length + 100; // over the character count, under the byte count
    expect(Buffer.byteLength(text)).toBeGreaterThan(limit);
    const r = await send(makeExecutor({ budget: { maxRequestBytes: limit } }), body);
    expect(r.status).toBe(413);
    expect(r.body.error.message).toContain(`the request is ${Buffer.byteLength(text)} bytes`);
  });

  test("maxResponseBytes counts UTF-8 bytes, not characters", async () => {
    const calls = [{ id: "a", proc: "test.echo@1", tenant: appA, args: "é".repeat(1_000) }];
    const full = JSON.stringify((await send(makeExecutor(), envelope(calls))).body);
    const limit = full.length + 100;
    expect(Buffer.byteLength(full)).toBeGreaterThan(limit);
    const r = await send(makeExecutor({ budget: { maxResponseBytes: limit } }), envelope(calls));
    expect(r.body.calls.a.error).toMatchObject({ name: "ResponseTooLarge", executed: true });
    expect(Buffer.byteLength(JSON.stringify(r.body))).toBeLessThanOrEqual(limit);
  });
});
