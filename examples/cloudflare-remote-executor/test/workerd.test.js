// Runs inside workerd through @cloudflare/vitest-pool-workers (issue #18,
// item 5): inProcess(executor) must work in the Workers runtime, not only in
// Node, because every consumer test that runs a procedure locally rests on it.
import { env, SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, test, expect } from "vitest";
import {
  createExecutor,
  defineProcedure,
  ProcedureRegistry,
  remote,
  inProcess,
  encodeValue,
  DetachedInstanceError,
} from "dynamo-bao/remote";
import { TenantContext, runWithBatchContext, getBatchContextCapacity } from "dynamo-bao";
import { executor, SECRET_HEADER } from "../src/executor.js";
import { createNote, getNote, deleteNote } from "../src/procedures.js";
import { Note } from "../src/models.js";
import { systemActor } from "../src/index.js";

const SECRET = env.DATA_BINDING_SECRET;
const newNoteId = () => Note.fields.noteId.getInitialValue(); // a ULID

test("this file really runs in workerd", () => {
  expect(navigator.userAgent).toBe("Cloudflare-Workers");
  expect(typeof process.versions.node).toBe("string"); // nodejs_compat is on
});

describe("inProcess(executor) under workerd, no DynamoDB", () => {
  const seen = [];
  const where = defineProcedure({
    name: "probe.where",
    version: 1,
    scope: "app",
    replay: "idempotent",
    async run(ctx, { wait }) {
      await new Promise((r) => setTimeout(r, wait));
      seen.push({ tenant: TenantContext.getCurrentTenant(), inBatch: Note.isInsideBatchContext() });
      return { tenant: ctx.tenant, now: ctx.now(), actor: ctx.actor, config: ctx.config };
    },
  });
  const date = defineProcedure({
    name: "probe.date",
    version: 1,
    scope: "app",
    replay: "idempotent",
    async run() {
      return { resetAt: new Date() };
    },
  });
  const row = defineProcedure({
    name: "probe.row",
    version: 1,
    scope: "app",
    replay: "idempotent",
    async run() {
      const note = Note._createFromDyItem({ noteId: "n1", text: "hi", tags: ["a"], createdAt: 5 });
      return encodeValue(note);
    },
  });
  const later = defineProcedure({
    name: "probe.later",
    version: 1,
    scope: "app",
    replay: "needs-ledger",
    async run(ctx) {
      ctx.waitUntil(new Promise((r) => setTimeout(() => ((deferred.done = true), r()), 20)));
      return "answered";
    },
  });
  const deferred = { done: false };
  const local = createExecutor({
    procedures: new ProcedureRegistry([where, date, row, later]),
    context: () => ({ models: { Note }, config: { FLAG: "x" } }),
    ingress: (req, e) => req.headers.get("x-k") === e.K,
    now: () => 99,
    region: "aws:us-west-2",
  });
  const client = (opts = {}) =>
    remote(inProcess(local, { env: { K: "k" }, headers: { "x-k": "k" }, ...opts }), {
      actor: systemActor("app-a"),
    });

  test("two calls in one envelope run concurrently, each in its own tenant and batch context", async () => {
    seen.length = 0;
    const out = await client().batch([
      { id: "a", procedure: where, args: { wait: 30 }, tenant: "app-a" },
      { id: "b", procedure: where, args: { wait: 1 }, tenant: "app-b", actor: systemActor("app-b") },
    ]);
    expect(out.a.ok.tenant).toBe("app-a");
    expect(out.b.ok.tenant).toBe("app-b");
    expect(seen.map((s) => s.tenant)).toEqual(["app-b", "app-a"]); // b finished first
    expect(seen.every((s) => s.inBatch)).toBe(true);
    expect(out.a.ok.now).toBe(99);
    expect(out.a.ok.config).toEqual({ FLAG: "x" });
    expect(out.a.ok.actor).toEqual(systemActor("app-a"));
  });

  test("the caller's own tenant and batch context are untouched", async () => {
    await TenantContext.runWithTenant("caller", () =>
      runWithBatchContext(async () => {
        await client().call(where, { wait: 0 }, { tenant: "app-a" });
        expect(TenantContext.getCurrentTenant()).toBe("caller");
        expect(getBatchContextCapacity()).toEqual({ read: 0, write: 0 });
      }),
    );
  });

  test("an actor for another app is refused", async () => {
    const r = await client().call(where, { wait: 0 }, { tenant: "app-b" });
    expect(r.error).toMatchObject({ name: "ActorTenantMismatch", refused: true });
  });

  test("a Date in a result is a CodecError outcome", async () => {
    const r = await client().call(date, {}, { tenant: "app-a" });
    expect(r.error.name).toBe("CodecError");
  });

  test("a row crosses as { $model, data } and hydrates detached", async () => {
    const r = await client().call(row, {}, { tenant: "app-a" });
    const note = Note.fromRemote(r.ok);
    expect(note.text).toBe("hi");
    expect([...note.tags]).toEqual(["a"]);
    expect(note.createdAt.getTime()).toBe(5);
    await expect(note.save()).rejects.toBeInstanceOf(DetachedInstanceError);
  });

  test("ctx.waitUntil reaches the platform's ExecutionContext and outlives the response", async () => {
    deferred.done = false;
    const ctx = createExecutionContext();
    const r = await client({ ctx }).call(later, {}, { tenant: "app-a" });
    expect(r.ok).toBe("answered");
    expect(deferred.done).toBe(false);
    await waitOnExecutionContext(ctx);
    expect(deferred.done).toBe(true);
  });

  test("ingress refuses a request without the secret", async () => {
    const r = await remote(inProcess(local, { env: { K: "k" } }), { actor: systemActor("app-a") }).call(
      where,
      { wait: 0 },
      { tenant: "app-a" },
    );
    expect(r.error).toMatchObject({ name: "IngressRefused", refused: true });
  });

  test("note.create refuses a call without a noteId, so a resend can't create a second note", async () => {
    const r = await remote(inProcess(executor, { env, headers: { [SECRET_HEADER]: SECRET } }), {
      actor: systemActor("app-a"),
    }).call(createNote, { text: "no id" }, { tenant: "app-a" });
    expect(r.error).toMatchObject({ name: "TypeError", message: expect.stringMatching(/noteId/) });
  });

  test("a transport failure is unknown", async () => {
    const broken = { fetch: () => Promise.reject(new Error("socket closed")) };
    const r = await remote(broken, { actor: systemActor("app-a") }).call(where, { wait: 0 }, { tenant: "app-a" });
    expect(r).toEqual({ unknown: true, reason: expect.stringMatching(/socket closed/) });
  });
});

describe.skipIf(!env.LIVE_DYNAMODB)("the example's procedures against DynamoDB, under workerd", () => {
  const tenant = `wd-${crypto.randomUUID()}`;
  const other = `wd-${crypto.randomUUID()}`;
  const data = (appId = tenant) =>
    remote(inProcess(executor, { env, headers: { [SECRET_HEADER]: SECRET } }), { actor: systemActor(appId) });

  test("create, replay, read and delete through inProcess(executor)", async () => {
    const noteId = newNoteId();
    const created = await data().call(createNote, { noteId, text: "from workerd", tags: ["x", "y"] }, { tenant });
    expect(created.ok.created).toBe(true);
    expect(created.capacity.write).toBeGreaterThan(0);

    // conditional replay: a resend reports the existing row instead of writing again
    const again = await data().call(createNote, { noteId, text: "resent" }, { tenant });
    expect(again.ok.created).toBe(false);
    expect(Note.fromRemote(again.ok.note).text).toBe("from workerd");

    const got = await data().call(getNote, { noteId }, { tenant });
    const note = Note.fromRemote(got.ok);
    expect(note.text).toBe("from workerd");
    expect([...note.tags].sort()).toEqual(["x", "y"]);
    expect(note.createdAt).toBeInstanceOf(Date);
    expect(got.capacity.read).toBeGreaterThan(0);

    // tenant isolation: the other tenant does not see it
    const elsewhere = await data(other).call(getNote, { noteId }, { tenant: other });
    expect(elsewhere.ok).toBeNull();

    const removed = await data().call(deleteNote, { noteId }, { tenant });
    expect(removed.ok.deleted).toBe(true);
  });

  test("one envelope, two tenants, against the real table", async () => {
    const a = newNoteId();
    const b = newNoteId();
    const out = await data().batch([
      { id: "a", procedure: createNote, args: { noteId: a, text: "A" }, tenant },
      { id: "b", procedure: createNote, args: { noteId: b, text: "B" }, tenant: other, actor: systemActor(other) },
    ]);
    expect(out.a.ok.created).toBe(true);
    expect(out.b.ok.created).toBe(true);
    await data().call(deleteNote, { noteId: a }, { tenant });
    await data(other).call(deleteNote, { noteId: b }, { tenant: other });
  });

  test("the example route calls the executor through the DATA self-binding", async () => {
    const noteId = newNoteId();
    const res = await SELF.fetch(`https://example.test/apps/${tenant}/notes`, {
      method: "POST",
      body: JSON.stringify({ noteId, text: "via binding", tags: ["t"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noteId, text: "via binding", tags: ["t"] });
    const read = await SELF.fetch(`https://example.test/apps/${tenant}/notes/${noteId}`);
    expect((await read.json()).text).toBe("via binding");
    await data().call(deleteNote, { noteId }, { tenant });
  });
});
