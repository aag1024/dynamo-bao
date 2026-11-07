/**
 * The acceptance test from design-docs/remote-procedure-executor.md
 * (Implementation sequence, Phase A) and issue #18 item 4:
 *
 *   A Node test stands up the executor in process, registers two procedures
 *   in two tenants, sends one envelope with both calls, and asserts
 *   outcomes, capacity, isolation (a throw in one call does not affect the
 *   other), and that a detached instance refuses to save.
 */
const { TenantContext } = require("../../src");
const testConfig = require("../config");
const { BaoModel, PrimaryKeyConfig } = require("../../src/model");
const { StringField, UlidField } = require("../../src/fields");
const {
  defineProcedure,
  ProcedureRegistry,
  createExecutor,
  remote,
  inProcess,
  encodeValue,
  DetachedInstanceError,
} = require("../../src/remote");
const { cleanupTestDataByIteration, initTestModelsWithTenant } = require("../utils/test-utils");
const { ulid } = require("ulid");

class AccNote extends BaoModel {
  static modelPrefix = "racc";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = { noteId: UlidField({ autoAssign: true }), text: StringField() };
  static primaryKey = PrimaryKeyConfig("noteId");
}

const createNote = defineProcedure({
  name: "note.create",
  version: 1,
  scope: "app",
  replay: "needs-ledger",
  async run(ctx, { text }) {
    const note = await ctx.models.AccNote.create({ text });
    return { note: encodeValue(note), tenant: ctx.tenant };
  },
});

const failAfterWrite = defineProcedure({
  name: "note.failAfterWrite",
  version: 1,
  scope: "app",
  replay: "needs-ledger",
  async run(ctx, { text }) {
    await ctx.models.AccNote.create({ text });
    throw new Error("failed after writing");
  },
});

let tenantA, tenantB;
beforeAll(() => {
  tenantA = ulid();
  tenantB = ulid();
  initTestModelsWithTenant(testConfig, tenantA).registerModel(AccNote);
  TenantContext.setDefaultTenant(null);
});
afterAll(async () => {
  await cleanupTestDataByIteration(tenantA, [AccNote]);
  await cleanupTestDataByIteration(tenantB, [AccNote]);
  TenantContext.reset();
});

test("one envelope, two procedures, two tenants: outcomes, capacity, isolation, detached rows", async () => {
  const executor = createExecutor({
    procedures: new ProcedureRegistry([createNote, failAfterWrite]),
    context: () => ({ models: { AccNote } }),
    ingress: (request, env) => request.headers.get("x-data-binding") === env.SECRET,
    plainReturns: true,
  });
  const transport = inProcess(executor, { env: { SECRET: "k" }, headers: { "x-data-binding": "k" } });
  const actor = (appId) => ({ kind: "system", appId, systemAuthority: false, preAuthenticated: false });
  const data = remote(transport, { actor: actor(tenantA) });

  let fetches = 0;
  const counting = { fetch: (req) => (fetches++, transport.fetch(req)) };
  const out = await remote(counting, { actor: actor(tenantA) }).batch([
    { id: "a", procedure: createNote, args: { text: "in A" }, tenant: tenantA },
    { id: "b", procedure: failAfterWrite, args: { text: "in B" }, tenant: tenantB, actor: actor(tenantB) },
  ]);
  expect(fetches).toBe(1); // one envelope, both calls

  // Outcomes: the call in tenant A succeeded although the call in B threw.
  expect(out.a.ok.tenant).toBe(tenantA);
  expect(out.b.error).toMatchObject({ name: "Error", message: "failed after writing" });
  expect(out.b.error.refused).toBeUndefined();

  // Capacity: each call reports its own write.
  expect(out.a.capacity.write).toBeGreaterThan(0);
  expect(out.b.capacity.write).toBeGreaterThan(0);

  // Isolation: each write landed in its own tenant only.
  const note = AccNote.fromRemote(out.a.ok.note);
  const inA = await TenantContext.runWithTenant(tenantA, () => AccNote.find(note.noteId, { bypassCache: true }));
  const inB = await TenantContext.runWithTenant(tenantB, () => AccNote.find(note.noteId, { bypassCache: true }));
  expect(inA.text).toBe("in A");
  expect(inB.exists()).toBe(false);
  const bRows = await TenantContext.runWithTenant(tenantB, async () => {
    const rows = [];
    for await (const page of AccNote.iterateAll({ batchSize: 10 })) rows.push(...page);
    return rows;
  });
  expect(bRows.map((r) => r.text)).toEqual(["in B"]);

  // A detached instance refuses to save.
  expect(note.isDetached()).toBe(true);
  expect(note.text).toBe("in A");
  note.text = "changed at the edge";
  await expect(note.save()).rejects.toThrow(DetachedInstanceError);
  const unchanged = await TenantContext.runWithTenant(tenantA, () => AccNote.find(note.noteId, { bypassCache: true }));
  expect(unchanged.text).toBe("in A");

  // The single-call path agrees.
  const single = await data.call(createNote, { text: "again" }, { tenant: tenantA });
  expect("ok" in single).toBe(true);
});
