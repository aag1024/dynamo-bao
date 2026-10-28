# Remote procedure executor: one cross-region trip per logical operation

Status: proposal (2026-10-27, revised the same day after an independent
review and a scope decision). Nothing here is implemented.

## Summary

Durable Objects should live near users. DynamoDB lives in one region. Code that
runs a chain of dependent DynamoDB calls from a DO far from that region pays a
cross-region round trip per call, which is why js-bao-wss currently pins its
fetch handler to `aws:us-west-2` and, as a side effect, drags every DO to
Oregon as well.

This document proposes a complement to dynamo-bao: a stateless worker pinned
next to DynamoDB that runs named *procedures* on behalf of callers in other
regions. A procedure is ordinary application code using the dynamo-bao model
API inside one batch and tenant context. A DO, Workflow, or unpinned worker
makes one cross-region trip per logical operation instead of one per
DynamoDB call.

dynamo-bao provides the executor, the procedure registry, the caller client,
the codec, and the test transport. The application provides the procedures,
the context resolver, and the deployment.

The executor collapses N trips into 1. It never collapses 1 into 0. Per-message
hot paths still need a caller-side cache; the executor is what refreshes it.

## Decision record

**v1 is procedures-first.** An earlier draft of this document specified a
declarative plan language: JSON steps with `$ref` dependencies, `when`
predicates, a level scheduler, and a transaction compiler, with procedures
as an escape hatch. An independent review (Codex, 2026-10-27) argued, and
the author agreed, that named procedures over a service-binding `fetch()`
deliver the whole network benefit using ordinary JavaScript for branching
and error handling, and that the plan language's interpreter, predicate
semantics, codec rules, and transaction compiler are a separate, larger
investment no consumer has yet justified.

What tipped it: in the single-bundle layout js-bao-wss has today, the
"deploy the data worker" step the plan language would remove is the same
deploy the caller gets anyway. The flexibility buys nothing until the edge
and data workers are split, and versioned procedure names carry most of the
weight at that point either way.

The plan language is preserved in Appendix A so it can be revisited when
callers demonstrate a need to compose ad hoc loads without a deploy.

## Problem

Evidence is from js-bao-wss at commit `58c4406aa` (paths relative to that
repo).

**The pin does two jobs, and one is the wrong one.** `wrangler.toml:30-48`
pins the fetch handler to `aws:us-west-2`, which lands in Seattle at a measured
15 to 20 ms per DynamoDB call. The same comment records roughly 165 ms per call
from a far colo (a scheduled isolate in Melbourne). DOs are created near the
first `get()`, and that first touch comes from the pinned handler, so every
ConnectionWorker and YjsRoom is created near Oregon. A user in Europe pays
roughly 140 ms of round trip on every WebSocket frame, including yjs updates
exchanged with another European user. No DO uses a `locationHint`
(`src/do-routing.ts`).

**The chattiness is worst exactly where DOs would run.** Serial DynamoDB
rounds per path, from reading the code. These are upper bounds on the common
path; several steps short-circuit (a direct owner grant skips the group query,
an empty membership list skips it too), so the real distribution has to be
measured, not multiplied.

| Path | Serial rounds | Notes |
|---|---|---|
| WS subscribe, `ConnectionWorker.handleDocumentSubscription` | up to ~9 | No `runWithBatchContext` in the DO, so every `find` is a bare GetItem; `Document.find` runs twice |
| Every yjs message, `validateDocumentAccess` | 1 to 3 | Full `authorizeDocumentAction` per message; `DocumentPermissionCache` exists but `DOC_PERF_CACHE_ENABLED` is set in no env |
| GET /documents/:id | 2 | Measured 4 calls, depth 2 |
| collections addDocument | ~18 | Capped by test at 18 calls |
| Function invoke before sandbox | ~7 | Unique-constraint lookup is 2 rounds; rate limit is 2 |
| Workflow run framework overhead | 51 | Measured 8.4 s from a far isolate (#2866) |
| Durable step trace | 2 per step | Awaited writes, `src/function-runs/durable-step-trace.ts` |

Workflows, cron, and durable function runs are already unpinned and already
pay the far-colo cost. DO code paths are not measured at all:
`src/services/dynamo-metrics.ts` only wraps the fetch handler.

**Earlier mitigations were caches, not fewer trips.** The DB_PERF_CACHE family
(`src/app-api/services/app-config-cache.ts`) is per-isolate stale-while-
revalidate. Only the memberships kind has a production reader, and it is
disabled on production and test. The permission-model doc rejected a KV or DO
cache because "its hop costs about what the DynamoDB query it replaces costs".
That is the correct objection to a cache in front of DynamoDB. It is not an
objection to batching: a hop that replaces nine queries is a different trade.

**Three improvements are bundled here and should be measured separately.**
Moving orchestration near DynamoDB, parallelizing reads and removing
redundant ones, and caching authorization plus relocating realtime objects.
The second needs no remote executor at all; some of the subscribe path's
gain is available today by restructuring the DO code with `Promise.all` and
a batch context. Spike 3 below isolates it.

## Alternatives considered

| Alternative | Attractive for | Why not, or not yet |
|---|---|---|
| Keep everything pinned; batch and cache locally | Cheapest baseline, useful regardless | Keeps the geographic realtime penalty for every non-US-West user |
| Declarative plan language (Appendix A) | Ad hoc composition of loads from a DO without a data worker deploy | Larger investment with no demonstrated consumer; deferred |
| DynamoDB Global Tables, read replicas with one write region | Read-heavy workloads needing local reads | Replication lag; writes stay remote; multi-region strong consistency mode does not support transactions, and multi-region eventual mode is last-writer-wins, which breaks unique-constraint rows and conditional counters |
| DO SQLite for room-local hot state | Connection mappings, presence, cached grants for one document | Worth doing for `ConnectionMapping`, which is queried by document and could live in the room DO; does not help global invariants or cross-object reads |
| D1 with read replication | SQL read models | Writes still go to the primary; a storage redesign, not a latency fix |
| Location-hinted executor DO near Oregon | If placement over service bindings turns out not to work | Single-threaded per object, needs sharding, `wnam` is not "next to the table" |
| Shipping code with the request (`worker_loaders`) | Untrusted customer code, which js-bao-wss already does this way | Wrong tool for the platform's own data access: an isolate per load, and a caller that can run anything against any tenant |

The DO SQLite row is the one genuine alternative for part of the problem:
moving `ConnectionMapping` into the room DO removes both the peer query and
the mapping create from DynamoDB entirely. It is independent of this proposal
and could precede it.

## Platform constraints

Facts from Cloudflare documentation, checked 2026-10-27.

- Explicit region placement (`placement.region = "aws:us-west-2"`) maps to the
  data center with the lowest latency to that cloud region. It is mutually
  exclusive with Smart Placement.
- "Placement only affects the execution of fetch event handlers. It does not
  affect RPC methods or named entrypoints." The RPC docs add that with Smart
  Placement, the callee "will run locally, on the same machine" as the
  caller. The placement page's own example nevertheless shows a placed
  back-end invoked over RPC. The documentation is contradictory; neither
  behavior is proven. Spike 1 settles it.
- Therefore the executor is designed to be reached by a service-binding
  `fetch()` to a worker with a fetch handler.
- Durable Objects accept a `locationHint` (`wnam`, `enam`, `weur`, ...), honor
  it only on first creation, and never move afterward. Unpinning the edge
  worker relocates nothing that already exists.
- Paid-plan limits: 10,000 subrequests per invocation (configurable), six
  connections simultaneously awaiting response headers (a seventh queues),
  30 s CPU by default and up to 5 minutes, 128 MB per isolate shared across
  concurrent requests, and `waitUntil` work runs for at most 30 s after the
  response. The six-connection limit bounds how wide a `Promise.all` really
  runs.
- RPC serialization is capped at 32 MiB; irrelevant for HTTP bodies but a
  reminder to keep results small.

**Verified by Spike 1 (2026-10-28).** No doc sentence confirms that a
service-binding `fetch()` to a region-placed worker honors the region, so
Spike 1 measured it: a separate-worker binding, an RPC method, and the
public hostname, from hinted DOs, from a Workflow, and from a worker placed
in `aws:us-east-1`. Binding and hostname `fetch()` ran in Seattle from every
caller; RPC ran in the caller's colo every time. The executor echoes its own
observed colo and timing in every response rather than relying on the
`cf-placement` header, which the docs describe as request metadata. Two
limits found on the way: a Worker's `fetch()` to another Worker's hostname
on the same zone (which includes the account's `workers.dev` subdomain) is
refused with Cloudflare error 1042, while the same fetch from a Durable
Object succeeds; and a self-binding was not tested, which is fine for the
single-bundle layout only because that worker is placed as a whole.

## Architecture

```
user ──ws──▶ edge worker (unpinned, near user)
                │  stub.fetch
                ▼
          ConnectionWorker / YjsRoom DO (created near user)
                │  env.DATA.fetch("/_data/call", envelope)   ← one trip
                ▼
          data worker (placement.region = aws:us-west-2)
                │  registry lookup, TenantContext, runWithBatchContext
                │  procedure runs: N calls at ~17 ms each, parallel where independent
                ▼
          DynamoDB us-west-2
```

**Ownership.** dynamo-bao ships the machinery and js-bao-wss ships the
worker. The library exports a function that returns a fetch handler; the
application decides where to mount it and what it can call. There is no
"data worker" package.

**Two layouts, in order.**

1. **Single bundle (first).** js-bao-wss is already one worker with a
   self-binding (`FUNCTION_GATEWAY`). The executor is one more route in the
   existing fetch handler, reached through a new `DATA` self-binding.
   Placement is already set, so the route runs in Seattle. The procedures
   and their callers are always the same build, so there is no version skew
   and no deploy ordering.
2. **Two bundles (later, to unpin).** Placement is per worker, so to put DOs
   near users the DO-owning worker must be unpinned while the executor
   stays pinned. The edge worker owns the WebSocket upgrade, DO routing, and
   the DO classes, and carries no DynamoDB credentials. The data worker owns
   the HTTP app API (whose routes gain nothing from the executor and stay
   next to DynamoDB) and the executor, and binds the DO namespaces back
   through `script_name`. Deploys are data worker first, edge second, from
   one script.

**Existing objects.** Moving DO class ownership and unpinning does not move
rooms that already exist near Oregon. The rollout needs an explicit
strategy: a version in the room name so that documents reopened after the
cutover land near their users, with the old namespace drained over time. A
shared room can only be near some of its collaborators; the gain is for the
common case of nearby collaborators.

## The protocol

A request is one envelope carrying one or more calls. Each call names a
procedure and version, a tenant, and JSON arguments. Nothing executable
crosses the wire.

```json
{
  "v": 1,
  "operationId": "conn_c1:subscribe:doc_1",
  "actor": { "kind": "system", "appId": "app_123" },
  "calls": [
    { "id": "sub", "proc": "document.subscribe@1", "tenant": "app_123",
      "args": { "appId": "app_123", "userId": "user_9", "documentId": "doc_1", "connectionId": "c1", "ttlMs": 300000 } }
  ]
}
```

```json
{
  "v": 1,
  "placement": { "colo": "SEA", "region": "aws:us-west-2" },
  "calls": {
    "sub": { "ok": { "level": "read-write", "routing": { "...": "..." }, "mapping": "created", "peers": [] },
             "capacity": { "read": 6.5, "write": 1 }, "ms": 41 }
  }
}
```

`actor` carries whatever ambient authority the application's code reads
today (in js-bao-wss, `systemAuthorityFor(appId)` and the caller's role).
Moving a function body behind the executor must not silently change what it
believes about who is calling; the envelope makes that explicit. Spike 6
fixed its shape for js-bao-wss:

```ts
interface Actor {
  kind: "user" | "system" | "admin";
  userId?: string;              // attribution; ids a procedure acts on are args
  appId: string;                // must equal the call's tenant or the executor refuses
  systemAuthority: boolean;     // what systemAuthorityFor(appId) answered at the caller
  preAuthenticated: boolean;    // "a person started this": the activity recorder's gate
  adminPartition?: string;      // GLOBAL_ADMIN_APP_ID the caller resolved, for scope "admin"
}
```

The other fields the gateway's store holds (agent-driven, function
principal, asserted step, dispatch run id and deadline) are not read by
any of the five services and are added when a procedure needs them.

### Outcomes

Every call settles to exactly one tagged outcome, and the distinction is
part of the protocol because callers make authorization decisions on it:

| Outcome | Meaning |
|---|---|
| `{ "ok": value }` | The procedure returned. |
| `{ "error": { "name", "message", ... } }` | The procedure threw. Application errors (`ConditionalError`, `ItemNotFoundError`, validation) keep their names; infrastructure errors are reported as such. |
| `{ "unknown": true }` | The caller's transport failed after the request was sent. The executor never produces this; the client does. |

Values go through a codec: `BaoModel` instances become `{ "$model", "data" }`
with binary, date, and set fields made JSON-safe; everything else must be
plain JSON. A procedure returns DTOs shaped for its caller; model instances
are for the cases that want to hydrate.

### Multiple calls per envelope

Calls in one envelope run concurrently and are isolated at the level of
exceptions, tenancy, and caches: each has its own `TenantContext`, its own
`runWithBatchContext`, its own capacity total, and no way to reference
another call's result. The WebSocket handshake needs this: the `App` row
lives in the admin tenant, `User` and `AppUser` in the app tenant.

What the envelope does not isolate: the calls share one invocation's CPU
budget, memory, connection slots, and response. The slowest call delays the
response for all of them. The executor enforces a per-request budget of
calls and bytes.

A follow-up client transport collects every `call()` issued in the same
macrotask into one envelope, the way dynamo-bao's `find` batching coalesces
into one `BatchGetItem`. It needs a maximum batch size and a `flush`
opt-out, and no server change.

### Transport failure and replay

A timeout after the executor has dispatched writes leaves the caller unable
to tell success from failure. `operationId` is the unit of replay. The
executor records nothing durable about it in v1, so the rules are enforced
through the procedure's declared replay class:

| Class | Meaning | Safe to resend? |
|---|---|---|
| `read-only` | No writes | Yes |
| `conditional` | Every write is a guarded state transition (`attribute_not_exists` create, update guarded on the previous value, conditional delete) | Yes; the second attempt fails its condition and the procedure reports that |
| `needs-ledger` | Contains an unguarded write or a counter | No; the procedure must persist its own marker keyed by `operationId`, or carry a `ClientRequestToken` and build its request deterministically |

The registry refuses to register a procedure without a replay class, and the
client refuses to resend a `needs-ledger` call automatically.

`ClientRequestToken` on `TransactWriteItems` is 36 characters, honored for
ten minutes, and only if the request is byte-identical. It protects a
transport resend. It does not protect a Workflow replay an hour later, and a
rebuilt request with a fresh timestamp or ULID fails with
`IdempotentParameterMismatch` inside the window. js-bao-wss's
`idempotent-transact.ts` solves only the resend case; durable settlement is
`needs-ledger`.

## Procedures

A procedure is an ordinary async function registered by name and version on
the data worker.

```ts
export const checkAndIncrement = defineProcedure({
  name: "rateLimit.checkAndIncrement",
  version: 1,
  scope: "app",
  replay: "conditional",
  async run(ctx, { spec, id }: { spec: RateLimitSpec; id: Record<string, string> }) {
    const { name, config } = resolveSpec(spec);
    const limitKey = await buildKey(name, id);
    const { windowStart, resetAt, ttl } = windowBoundaries(config.windowSeconds);
    const { RateLimitWindow } = ctx.models;
    const pk = RateLimitWindow.makePrimaryId(limitKey, windowStart);
    const bump = () => RateLimitWindow.update(pk, { count: "+1" },
                         { condition: { count: { $lt: config.limit } } });
    try { return allowed(await bump(), config, resetAt); }
    catch (e) {
      if (e instanceof ConditionalError) return denied(config, resetAt);
      if (!(e instanceof ItemNotFoundError)) throw e;          // infrastructure errors propagate
    }
    try {
      return allowed(await RateLimitWindow.create({ limitKey, windowStart, appId: ctx.tenant, count: 1, ttl }), config, resetAt);
    } catch (e) { if (!(e instanceof ConditionalError)) throw e; }
    return allowed(await ctx.fresh(bump), config, resetAt);   // lost the create race
  },
});
```

Properties:

- Runs on the executor inside the call's batch and tenant context. Its
  DynamoDB calls cost the local rate, `find`s issued in the same tick
  coalesce into one `BatchGetItem`, and the loader cache dedupes repeated
  reads.
- Addressed by name and version over the wire, never by code. Versioning
  exists from day one because, after the worker split, long-lived DOs and
  replayed Workflows will call into a newer deployment than the one that
  issued the call. The executor serves the previous version of a procedure
  for one deployment cycle.
- Declares its replay class.
- Calls other procedures as plain functions. There is no second RPC layer
  inside the executor.
- Is the migration unit. The first version of any hot path is a single
  procedure wrapping the existing function body with its I/O context
  swapped for `ctx`. Restructuring independent awaits into one
  `Promise.all` is the optimization that follows.

### Procedure context

```ts
interface ProcedureContext {
  models: AppModels;            // the call tenant's dynamo-bao models, batching on
  adminModels?: AdminModels;    // only when the registry entry declares scope "admin" | "both",
                                // built for the admin partition the envelope names
  tenant: string;               // read-only; also a value, since rows store appId
  actor: Actor;                 // the envelope's actor, for code that read ambient authority
  requestId: string;
  logger: Logger;               // info/warn/debug/error(message, detail?), bound to requestId + tenant
  now(): number;                // the call's clock; tests pin it, four of the five services stamp it
  fresh<T>(fn: () => Promise<T>): Promise<T>;   // nested batch context; see below
  waitUntil(p: Promise<unknown>): void;         // deferred work next to DynamoDB, 30 s cap, really awaited
  config: ReadonlyEnvConfig;    // flags and settings (DB_PERF_CACHE_*, LOG_LEVEL), no bindings
}
```

Spike 6 fixed the shape above (see its result). `now`, the logger
signature, the admin partition and `tenant` as a value each come from a
service that reads them ambiently today. Return values are plain views:
dates as epoch milliseconds, rows as `fromRemote` input, never a `Date` or
a model instance, because `resetAt`, the activity record and reconcile's
`row` all cross the boundary today as class instances and at least one
caller calls a method on them.

`fresh` runs `fn` in a nested `runWithBatchContext` for the "re-read after a
lost conditional write" pattern. A nested context has its own loader cache
and its own capacity accumulator, so `fresh` merges the nested capacity into
the call's total when it returns and primes the outer cache with rows the
nested work wrote. Without both, the call under-reports capacity and a later
`find` returns a stale row.

**Scope is a convention for trusted code, not a capability boundary.**
`TenantContext.runWithTenant` sets an async-local value; a procedure that
imports a model class directly and calls it under a different context is
not stopped by anything. The registry checks the declared scope before
running a procedure and `adminModels` is only constructed for procedures
that declared it, which keeps the capability visible in one place. It does
not make the executor safe against a hostile procedure, and it is not meant
to.

Deliberately absent from `ctx`, and why:

- **DO namespaces and stubs.** A DO call from the executor is a cross-region
  hop back toward the user. Fan-out is the caller's job using rows the
  procedure returned.
- **WebSocket sends, alarms, DO storage, the notifier.** The executor has no
  socket or object state.
- **Service bindings and the raw env.** Exposing bindings invites
  orchestration where only data access belongs. Needing one is a sign the
  work belongs on the caller.
- **Tenant switching at runtime.** Scope is declared at registration.

This list is about where network hops originate, not about keeping business
logic out. Authorization, rate limiting, and settlement are application
logic and they belong in procedures.

### What procedure code calls

The dynamo-bao model API as the application uses it today, with
`ctx.models` in place of `getAppModels(env)`. The executor has already
entered the tenant and opened a batch context, so the library's round-trip
reducers are on:

- Finds issued in one tick coalesce into one `BatchGetItem` per model.
- The loader cache dedupes repeated finds within a call.
- `batchFind` for known id lists, up to 100 per call.
- `queryByIndex(..., { loadRelated: true })` for a page plus its related rows.
- Conditional `update`, `delete`, and `create` without a pre-read, which the
  pending read-before-write work in this repo makes true for plain updates.
- `ctx.fresh` and `ctx.waitUntil` as above.

```ts
async run(ctx, { appId, userId, documentId, connectionId, ttlMs }) {
  const { Document, DocumentPermission, AppMembership, DocumentGroupPermission, ConnectionMapping } = ctx.models;
  const [doc, direct, memberships, groups] = await Promise.all([   // one tick: 1 BatchGet + 2 queries
    Document.find(documentId),
    DocumentPermission.find({ documentId, userId }),
    queryAllPages(AppMembership, "membershipsForApp", appId, { membershipKey: { $beginsWith: `${userId}#` } }),
    DocumentGroupPermission.queryByIndex("groupPermissionsForDocument", documentId),
  ]);
  const level = selectLevel(direct, memberships, groups, doc);     // pure
  if (!level) return { level: null };
  try { await ConnectionMapping.create({ connectionId, userId, documentId, appId, ttl: new Date(Date.now() + ttlMs) }); }
  catch (e) { if (!(e instanceof ConditionalError)) throw e; }     // existed: fine
  return { level, routing: documentRoutingOfRecord(doc) };
}
```

Two rounds to DynamoDB, one trip from the DO.

## Caller API

```ts
import { remote } from "dynamo-bao/remote";
import { subscribeToDocument } from "../procedures/document-subscribe.js";   // descriptor only

const data = remote(env.DATA, { actor: systemActor(appId) });
const r = await data.call(subscribeToDocument, args, { tenant: appId });

if ("ok" in r) { /* r.ok is typed from the descriptor */ }
else if ("unknown" in r) { /* decide by the procedure's replay class */ }
else { /* r.error */ }
```

- `remote(transport, { actor })` wraps a service binding or any
  `{ fetch(Request) }`. `call` posts one envelope and returns a tagged
  outcome. Capacity is fed into the caller's own batch-context accumulator
  if one is active.
- `inProcess(executor)` is a transport that runs the procedure in the same
  isolate with no network, for tests and `wrangler dev`.
- `Model.fromRemote(row)` hydrates a detached instance from an `ok` model
  value. On a detached instance, `save`, `update`, `delete`,
  `loadRelatedData`, and `getOrLoadRelatedField` throw with a message
  pointing at the procedure API. Static model methods are not guarded; the
  real boundary is that the edge bundle holds no DynamoDB credentials.
- The client never resends a `needs-ledger` call on its own.

### Rules for callers

1. Everything that touches DynamoDB for one logical operation goes in one
   procedure. If a caller finds itself making two calls in sequence where the
   second depends on the first, that is one procedure.
2. Procedures return DTOs shaped for the caller. Ship back only what the
   caller will use.
3. Do not send per-message checks through the executor. Cache on the
   caller, refresh through a small procedure, invalidate on push.
4. Fan-out, socket replies, DO storage, and alarms stay on the caller.
5. Handle `unknown` explicitly, according to the procedure's replay class.

## What changes in dynamo-bao

New entry point `dynamo-bao/remote`, implemented in `src/remote/`:

| Module | Exports | Tests |
|---|---|---|
| `procedures.js` | `defineProcedure`, `ProcedureRegistry` | Registration, version lookup, previous-version serving, refusal without replay class or scope |
| `context.js` | `createContext`, `fresh` | Tenant entry, batch context, capacity merge from `fresh`, outer cache priming, `waitUntil` passthrough |
| `codec.js` | `encodeValue`, `decodeRow` | Every field type in `fields.js`, including binary, date, set, counter, TTL; rejection of non-JSON values |
| `executor.js` | `createExecutor({ procedures, context, ingress, budget })` | Envelope validation, unknown procedure, scope check, multi-call concurrency and isolation, outcome encoding, capacity reporting, placement echo, budget refusal, ingress refusal |
| `client.js` | `remote`, `inProcess` | Round trip through the executor in process, outcome typing, `unknown` on transport failure, no auto-resend for `needs-ledger`, capacity passthrough |
| `model.js` (existing) | `static fromRemote`, detached flag | Hydration from encoded rows; every guarded method throws on a detached instance |

Plus `examples/cloudflare-remote-executor/` showing the mount, the
self-binding, the placement line, and the ingress secret, and a tutorial.

Size: roughly 500 to 800 lines of library code plus tests. None of it
depends on the mutation-mixin internals, so it can proceed in parallel with
the pending read-before-write work; the two meet only in that conditional
writes without a pre-read make procedures shorter.

Not in dynamo-bao: a `wrangler.toml`, a worker entry, placement settings,
binding names, or ingress policy. Those are deployment decisions and belong
in the example and in the application.

## What the application writes

Three things.

**A procedures directory.** Each file exports descriptors; an index builds
the registry.

```ts
// src/procedures/index.ts
export const procedures = new ProcedureRegistry([
  subscribeToDocument, recordAppActivity, checkAndIncrement, settleRunRow, /* ... */
]);
```

**A context resolver and the mount.** The library does not know how the app
builds its model sets or what an actor is.

```ts
// src/remote-executor.ts
export const executor = createExecutor({
  procedures,
  context: (call, env) => ({
    models: call.tenant.admin ? getAdminModels(env) : getAppModels(env),
    adminModels: call.scope !== "app" ? getAdminModels(env) : undefined,
    actor: call.actor,
    config: readOnlyConfig(env),
  }),
  ingress: (request, env) => request.headers.get("x-data-binding") === env.DATA_BINDING_SECRET,
  budget: { maxCalls: 8, maxResponseBytes: 1_000_000 },
});

// src/index.ts fetch handler
if (url.pathname === "/_data/call") return executor.fetch(request, env, ctx);
```

```toml
# wrangler.toml — [placement] region = "aws:us-west-2" already present
[[services]]
binding = "DATA"
service = "js-bao-wss"
```

**Guard rails.** An ESLint restriction on importing `getAppModels` and
`getAdminModels` from `connection-worker.ts`, `rooms/**`, `agents/**`,
`*-do.ts`, and the Workflow entry points, so the "no DynamoDB from DO code"
rule does not erode. After the worker split, no DynamoDB credentials in the
edge bundle.

**Tests.** Procedure tests are plain function tests:
`await subscribeToDocument.run(makeCtx(models), args)` against the existing
test table, the same shape as the current service tests. Caller tests and
`wrangler dev` use `inProcess(executor)`, so the DO and the procedure run
in one process with no network. The executor itself is tested once, in
dynamo-bao.

**The everyday change.** In the single-bundle layout, "the DO needs one
more field" is: add it to the procedure's return DTO, read it in the DO,
test, `wrangler deploy`. One PR, one deploy. A new access pattern is a new
procedure file, a test, and a caller. After the split it is two deploys in
order, data worker first, from one script, with the version in the
procedure name covering the gap.

## Worked examples (js-bao-wss)

**Simple: record app activity.** Today `writeActivity` in
`app-activity-recorder.ts` reads the `App` row, decides locally, and issues
a conditional update guarded on what it read: two serial rounds, about
330 ms from a Workflow. The procedure is that body with `ctx.adminModels`
for `getAdminModels(env)` and no `withAdminContext`, replay class
`conditional`. The caller keeps the per-isolate slot claim, the audit log,
and the never-throw contract, and treats `unknown` as "not written", which
is safe only because the write is guarded. One trip.

**Complex: WebSocket subscribe.** Today `handleDocumentSubscription` runs
authorization (up to three serial rounds), the mapping create, a second
`Document.find`, and the peer query in sequence, none batched. The
procedure runs the authorization service, the document read, and the peer
drain in one `Promise.all`, then the gated mapping create, and returns
`{ level, routing, mapping, peers, invalidPeers }`. `DocumentPermissionService`
needs one change: a constructor that takes models and an actor from `ctx`
instead of reading `getAppModels(env)` and `systemAuthorityFor(appId)` as
ambient state. The caller keeps the socket reply, seeds
`DocumentPermissionCache` from `level`, stores the routing, and fans out to
peers. Up to nine serial rounds become one trip plus two executor levels.

**Per-message access check.** Zero trips. The subscribe procedure returned
`level`; the DO seeds the cache (the class needs a seed method; today it
only has a loader callback) and reads it per message. A refresh procedure
reruns the authorization reads when the TTL lapses or when an access-diff
broadcast from `emitAccessDiff` names this user and document. The cache
needs a revocation protocol, not just a flag: a stated stale-allow window, a
generation number per entry so a refresh started before a revocation cannot
repopulate the revoked grant, and a rule for reconnects and hibernation.

**Function invoke.** The unique-constraint lookup, the config read, the
membership drain, the CEL gate, and the rate-limit reservation become one
procedure with the independent reads overlapped. From a durable run the
path drops from roughly 1.2 s to about 250 ms.

**Durable step trace.** The recorder settles step N when it returns and
opens step N+1 when it is invoked, as two awaited writes, and arbitrary user
code or a hibernation can sit between them. Merging them into one call means
buffering the settle until the next open or the run's end, which changes
what an operator sees for a sleeping step. That is a recorder redesign with
a durability trade, not a transport change.

## Security and tenancy

- The executor accepts requests only through the service binding. Under the
  single-worker layout, the route verifies a binding secret and refuses
  public ingress, and that refusal is tested. Under the two-worker layout
  the executor worker has no public route at all.
- `tenant` on each call is enforced by `TenantContext` on the executor, one
  context per call. The caller can name any tenant only because the caller
  is trusted code; this is the same trust boundary as the DO code that calls
  `withAppContext` today, moved one hop.
- `actor` in the envelope is the only source of ambient authority inside the
  executor. Code moved behind a procedure reads `ctx.actor`, never a module
  global.
- Procedure, version, scope, and tenant kind are validated together before
  the procedure runs.
- Protocol version `v` and procedure versions are in the format from the
  first deployment.

## Impact estimate

Assumptions: 17 ms per DynamoDB call from the data worker, 140 ms cross-region
round trip for a user in Europe. Halve the 140 ms term for a user in the US
East. All figures are estimates from round counts, not measurements, and the
DO paths have no baseline today. Spikes 2 and 3 replace this table with
measurements from the spike worker before any topology decision, and
Phase B replaces those with product measurements.

| Operation | Pinned today | DOs near users, no executor | DOs near users, with executor |
|---|---|---|---|
| WS subscribe (up to 9 rounds) | 150 ms + 140 ms frame RTT | up to 1,260 ms | ~180 to 200 ms |
| yjs update between two EU users | ~160 to 190 ms | 160 to 440 ms | ~25 ms on cache hit, room permitting |
| GET /documents/:id (HTTP) | 174 ms | 280 ms | 174 ms (stays on the data worker) |
| Workflow framework overhead (51 calls) | 8,415 ms measured | 8,415 ms | 870 ms of DynamoDB time plus 140 ms per irreducible boundary; boundary count unknown until the engine's bookkeeping is grouped |
| Durable function `ctx.db` call (3 rounds) | ~500 ms | ~500 ms | ~190 ms |

Three conclusions:

1. For HTTP routes the executor changes nothing. Keep them on the pinned data
   worker.
2. Workflows and durable runs are the first customer because they are
   already remote and already measured at the far-colo rate. They are not
   risk-free: settlement and replay are exactly where the replay classes
   bite.
3. The product win is realtime latency outside the US West, and it comes
   from unpinning the DOs and relocating rooms. The executor is what makes
   unpinning affordable; the room relocation strategy is what makes it
   real.

## Validation spikes (before implementation)

Each spike has a question, a method, and a decision it feeds. None of them
touches js-bao-wss code, and none of them depends on alpha traffic: alpha
has too little consistent load to be a representative sample, and the
product should not carry spike instrumentation. Instead, the spikes run in
a standalone **spike worker** with its own resources and synthetic load.
Spikes 4 and 6 are read-only audits of js-bao-wss source. They can run in
parallel; 1 and 3 are the gating ones.

### The spike worker

A directory in this repository, `exp/spikes/executor/`, modeled on
`js-bao-wss/tools/latency-lab`, which already has the right shape: one
script deployed under several placements, its own DynamoDB table and IAM
user tagged for teardown, a `resources.sh` naming every resource, and a
`teardown.sh` that deletes exactly those. It lives here rather than in its
own repo because the npm package's `files` list (`bin/`, `src/`,
`README.md`) keeps it out of the published tarball, and because a
`file:../..` dependency makes it exercise the working tree's library code
(including the pending read-before-write work) instead of a release. The
two things latency-lab hardcodes that must not land in a public repo, the
Cloudflare account id and the custom zone, move to a gitignored
`.dev.vars` and to `workers.dev` hostnames, which also serve as the public
hostname Spike 1 needs. Results go in a gitignored `results/`. The spike
worker copies latency-lab's scaffolding and differs in three ways:

- It uses **dynamo-bao 0.8.0** over aws4fetch, not raw `GetItem`, so what
  it measures is the library's actual call pattern (per-tick batching,
  loader cache, conditional writes, TransactWrite for unique constraints).
- Its `models.yaml` **mirrors the js-bao-wss models on the subscribe and
  function-invoke paths** (`Document`, `DocumentPermission`,
  `DocumentGroupPermission`, `AppMembership`, `ConnectionMapping`, `App`,
  `AppFunction`, the rate-limit counter), copied by hand from
  `js-bao-wss/src/models/*.js` and `models.yaml` with the same indexes and
  field types. A `seed.mjs` writes a few thousand documents, members, and
  connections at realistic item sizes. The product's tables are never read
  or written.
- It carries **hand-written replicas of the call sequences** under test,
  not the product's code: `subscribe` as it runs today
  (`handleDocumentSubscription`'s order of reads and the mapping create),
  `invoke` (`runInvocation`'s lookups plus `checkAndIncrement`), and the
  per-message `validateDocumentAccess` check. Each replica is a list of
  dynamo-bao calls in the product's order, with the product's branches
  (owner short-circuit, explicit permission, group permission, no
  memberships) selectable per request. They are transcribed from a read of
  the product source and reviewed against it; that review is the
  correctness risk of this approach and is stated in the results.

Deployables, all from one script, as latency-lab does it:

| Script | Placement | Role |
|---|---|---|
| `spike-data` | `aws:us-west-2` | the executor stand-in: fetch route and RPC entrypoint, runs replicas and returns `{ colo, calls, perCallMs, totalMs }` |
| `spike-edge` | none (runs where the request enters) | hosts the `SpikeDO` class and a `SpikeWorkflow`; binds `spike-data` by service binding and by hostname |
| `spike-edge-use1` | `aws:us-east-1` | a third vantage point, to tell "far from the data" from "in Europe" |

`SpikeDO` is created with a `locationHint` taken from the request
(`wnam`, `enam`, `weur`, `apac`, `oc`), one instance per hint, and runs
each replica in three modes: **serial** (today's code), **local-parallel**
(same calls under `runWithBatchContext` with the independent reads in one
`Promise.all`, no executor), and **remote** (one call to `spike-data`,
which runs the replica in Seattle). The DO reports its own colo from
`request.cf` on first contact, so every sample records where it actually
ran.

The load generator is a script on a laptop looping over
`{ hint × replica × mode × branch }` with 50 warm and 10 cold samples per
cell, run at three times of day, writing one CSV row per sample to
`results/`. The laptop's location does not matter: the quantity under
test is DO-to-DynamoDB and DO-to-executor time, which is a function of the
DO's hint and not of the client. The client-to-DO leg is left out on
purpose; it is a known function of distance and is what unpinning is meant
to shorten.

The scaffold, models, replicas, seed, driver, and setup/teardown scripts
were written 2026-10-27 and bundle under wrangler; they have not yet been
deployed or run. The replicas were transcribed from a read of the product
source the same day; each file's header lists what it models and omits.
One fidelity note: the product runs dynamo-bao 0.7.0, whose `update` and
`delete` always read before writing; the spike runs the working tree, which
does not. The spike therefore measures the product as it will be after the
Phase B upgrade, not as it is today. The worker is torn down when the spikes are done; nothing in it is
meant to ship, though the `spike-data` script is a natural first draft of
`examples/cloudflare-remote-executor/`, one directory over.

### The spikes

**Spike 1: placement over bindings.** *Question:* does a service-binding
`fetch()` to a region-placed worker run in that region, and what does the
hop cost? *Method:* `spike-data` exposes a fetch route and an RPC method,
each doing ten sequential `find`s on a missing key and returning
`{ colo: request.cf.colo, perCallMs, totalMs }`. Call it from `SpikeDO`
under each hint, from `SpikeWorkflow`, and from `spike-edge-use1`, through
the service binding's `fetch()`, the RPC method, and the public hostname,
cold and warm. *Decision:* which transport the executor uses, and the real
per-hop overhead for the estimates. *Fail condition:* no binding form runs
in Seattle; then the executor is reached by hostname, or the hinted-DO
fallback is revisited. One day on top of the harness.

*Result (2026-10-28, `results/spike1*.csv`, 20 warm + 5 cold samples per
cell, cold rounds 90 s apart).* **Passed: use the binding.** Every binding
and hostname sample ran `spike-data` in SEA, from the `weur` DO (LIS), the
`wnam` DO (LAX), the unplaced edge worker (SJC), the `us-east-1` worker
(IAD) and the Workflow (LAX). RPC never did: it ran in the caller's colo and
made the ten DynamoDB calls from there. Hop is the caller's total minus what
`spike-data` measured for itself; p50 in ms:

| Caller (colo) | binding hop warm / cold | hostname hop warm | RPC total (runs at caller) warm / cold | ten Gets locally, warm / cold |
|---|---|---|---|---|
| `weur` DO (LIS) | 189 / 180 | 182 | 1607 / 2266 | — |
| `wnam` DO (LAX) | 53 / 62 | 67 | 403 / 639 | — |
| `apac` DO (HKG), warm only | 157 | — | — | 1650 |
| `oc` DO (MEL), warm only | 176 | — | — | 1645 |
| edge worker, unplaced (SJC) | 41 / — | refused (1042) | 274 / — | 281 / — |
| `us-east-1` worker (IAD) | 89 / 144 | refused (1042) | 979 / 1055 | 1262 / 1018 |
| Workflow (LAX), one sample | 169 round trip | — | — | — |

The data-side work, ten sequential `find`s on a missing key from SEA, took
117 to 136 ms warm and 151 to 174 ms cold in every cell: about 12 ms per
call, with the first call near 59 ms for connection setup. So the impact
estimate's 17 ms per call is conservative and its 140 ms cross-region term
is optimistic for Lisbon (the hop is about 185 ms there, 55 ms from Los
Angeles, 90 ms from Ashburn, 157 ms from Hong Kong, 176 ms from Melbourne). The hop does not go cold; what goes cold is
the data isolate and its connection, worth 20 to 40 ms. Remote beat local
even from the nearest vantage: the SJC worker running the ten Gets itself
took 281 ms against 158 ms through the binding to Seattle. The hostname
transport works from a DO but a Worker calling another Worker on the same
zone is refused (error 1042), so hostname is a fallback for DO callers
only. Decision: the executor is reached by service-binding `fetch()`; RPC
is out; the hinted-DO fallback is not needed.

**Spike 2: DO baseline, reconstructed.** *Question:* what do the DO paths
cost today? *Method:* the `serial` mode of each replica, run from the
`wnam` hint, which is where the product's DOs live now. Per-call latency
is measured; the call sequence is the transcribed one, so the baseline is
"measured per-call time times the product's round structure", not a
measurement of the product. The branch distribution (how many subscribes
hit the owner short-circuit, how many fall through to group permissions)
is a parameter the report shows both ends of, not a measurement.
*Decision:* the "pinned today" column of the impact table, with error bars.
*Fail condition:* none; this is measurement. The product's own baseline
comes later, in Phase B step 1, when `runWithDynamoMetrics` wraps the DO
paths as product code. Half a day of runs.

*Result (2026-10-28, `results/spike2.csv`, 50 warm + 10 cold samples per
cell, `wnam` DO in LAX, serial mode, replicas reviewed against the product
source the same day and found faithful on these two paths).* Every
DynamoDB call from Los Angeles costs about the same: Get 41 ms, Query 43
ms, conditional Update 44 ms at p50 warm, p95 51 to 53 ms; so a path costs
its round-trip depth times about 42 ms, and the branch decides the depth.
p50 in ms, warm / cold, with the depth in round trips:

| Path, branch | depth | warm | cold |
|---|---|---|---|
| subscribe, owner (direct grant short-circuits) | 4 | 182 | 330 |
| subscribe, reader (direct grant + link floor) | 5 | 216 | 231 |
| subscribe, group (memberships + group grant) | 5 | 211 | 243 |
| subscribe, link (no grant, document floor) | 5 | 208 | 232 |
| subscribe, deny (stops after auth) | 2 | 83 | 94 |
| per-message check, owner | 1 | 44 | 49 |
| per-message check, reader / group / link | 2 | 82 to 92 | 86 to 100 |
| per-message check, deny | 2 | 83 | 87 |

Reading: a new subscription by anyone but the owner costs about 210 ms of
DynamoDB waiting from the product's current DO location, and every Yjs
message from a non-owner pays about 85 ms before it is forwarded; the
owner pays 44 ms. The "pinned today" column of the impact table should use
these, not the 17 ms × rounds estimate, and the cross-region term from
Spike 1 says what the same depth would cost from Lisbon (about 190 ms per
round trip) or Hong Kong (about 160 ms). Two caveats. First, "cold" here
is only partly cold: the driver runs the ten cells in order within each
cold round, so only the first cell (subscribe, owner) pays the DO and
connection start, which is why it alone jumps; cold p95 for a first call
was 161 ms against 53 ms warm. Second, the harness runs dynamo-bao 0.8.2
from the working tree, and the product runs the same version, so there is
no update pre-read difference to account for on these paths.

**Spike 3: location and structure, separated.** *Question:* how much of
the subscribe gain is parallelism, how much is location, and what does the
"DOs near users, no executor" column really cost? *Method:* the full
`{ hint × mode }` matrix for the `subscribe` replica. `serial` at `wnam`
is Spike 2; `local-parallel` at `wnam` is the gain available today without
moving anything; `serial` and `local-parallel` at `weur`, `apac`, and `oc`
are the cost of unpinning naively; `remote` at those hints is the
executor's promise. *Decision:* separates improvement 2 from improvement 1
in the problem statement, and tells you whether the pinned topology alone
is acceptable for a while. *Fail condition:* if `local-parallel` at `wnam`
gets most of the way, the executor's priority drops and the restructuring
ships on its own as a product change. One day of runs once Spike 1's
transport is chosen.

*Result (2026-10-28, `results/spike3.csv`, 45 cells × 50 warm + 10 cold,
branches owner / group / deny, 6 driver-side "fetch failed" rows
excluded).* The DOs landed at LAX, ORD, LIS, HKG and MEL. `subscribe` for a
group member, the common non-owner case, p50 warm in ms:

| DO location | serial (today's code) | parallel (restructured, no executor) | remote (one binding call to Seattle) | hop inside remote |
|---|---|---|---|---|
| `wnam` LAX | 192 | 97 | 110 | 46 |
| `enam` ORD | 347 | 129 | 126 | 61 |
| `weur` LIS | 837 | 358 | 237 | 169 |
| `apac` HKG | 847 | 312 | 214 | 151 |
| `oc` MEL | 831 | 333 | 234 | 171 |

Owner (depth 4 → 2) follows the same shape: 152 / 96 / 103 at LAX, 662 /
348 / 219 at LIS. Deny (depth 2 → 1) is where remote cannot win: 94 / 41 /
69 at LAX, 333 / 197 / 195 at LIS, because a one-round path has nothing
left to collapse and still pays the hop.

Three readings. **Structure first.** At `wnam`, `parallel` gets all the
way: it halves every path and `remote` only ties it, so by this spike's
own fail condition the batch-context restructuring ships on its own as a
product change before any executor. **Location is what the executor is
for.** Unpinning without it costs a European or Asian user 310 to 360 ms
per subscription even after the restructuring, against 210 to 240 ms
through the executor; and the gap widens on a fresh DO: cold `parallel`
at LIS / HKG / MEL was 830 to 850 ms (owner) because each concurrent read
opens its own connection and every handshake is a far round trip, while
cold `remote` stayed at 245 to 255 ms. A DO near a user that has not
opened connections yet is the normal case for a new document. **The hop
is the floor.** Remote at a far hint is hop (150 to 170 ms) plus the
work in Seattle (60 to 70 ms), so no per-operation design beats about 220
ms from Europe or Asia; what the executor buys is that the number stops
depending on the path's depth.

**Spike 4: codec coverage.** *Question:* is `_dyData` JSON-safe for every
model in js-bao-wss? *Method:* a read-only script over js-bao-wss's
`models.yaml` and `src/models/*.js` listing field types per model against
dynamo-bao's `fields.js`, flagging binary, set, and date representations.
Lives in `exp/spikes/executor/audit/codec-coverage.mjs`. *First run,
2026-10-27:* 81 models; every field type is JSON-safe except
`StringSetField`, used by 9 fields (`Document.tags`,
`DocumentGroupPermission.sourceCollectionIds`, `ServerFunctionConfig.capabilities`,
`AdminSession.scope` and `.apps`, `WorkflowDefinition.capabilities`,
`AppKeyReservation.holders`, `FeatureFlag.enabledAppIds` and `.disabledAppIds`).
No binary fields. Dates travel as numbers and need `fromRemote` to become
`Date` again. *Decision:* the codec's scope and whether
`fromRemote` is needed early or DTOs suffice. Half a day.

**Spike 5: Workflow version pinning.** *Question:* does a Workflows
instance mid-run keep the worker version it started on, or pick up a new
deploy at its next step? *Method:* docs first, then `SpikeWorkflow` with a
long sleep across a redeploy of `spike-edge` that changes a logged
constant. *Decision:* how aggressive the previous-version serving rule in
the registry has to be. Half a day.

*Result (2026-10-28).* **Instances are not pinned.** A `SpikeWorkflow`
instance started under `BUILD_TAG=dev`, ran its first step, slept six
minutes; `spike-edge` was redeployed with `BUILD_TAG=v2` at 16:50 UTC; the
step after the sleep ran at 16:55 and reported `v2`. So a Workflow's later
steps run whatever is deployed when they execute, and a long-lived
instance never calls the executor with a stale procedure version on its
own account. The registry's previous-version rule only has to cover the
two-bundle deploy window (edge callers deployed before the data worker),
not instance lifetimes; what a redeploy does put at risk is the reverse,
new step code consuming a persisted result produced by old step code,
which is the application's step-output compatibility problem and not the
executor's. Incidentally this instance ran in CDG (the earlier probe ran in
LAX): Workflows run wherever they are scheduled, and the binding still
reached Seattle, with a 176 ms hop from Paris.

**Spike 6: ambient context audit.** *Question:* what do the services to be
moved read from module globals or `env`? *Method:* read
`document-permission-service.ts`, `rate-limit.ts`, `app-activity-recorder.ts`,
`run-row-settlement.ts`, and `dispatch-reconcile.ts` for `getAppModels(env)`,
`systemAuthorityFor`, SWR caches keyed on `env`, loggers, and feature flags.
Read-only; the findings go in `exp/spikes/executor/audit/ambient-context.md`.
*Decision:* the
final shape of `ProcedureContext` and the `actor` type. One day of reading.

*Result (2026-10-28, `exp/spikes/executor/audit/ambient-context.md`, every
claim cited to a line; the highest-impact ones re-checked by hand).* Two of
the five live elsewhere than named: settlement is
`server-functions/run-row-settlement.ts` and reconcile is
`function-runs/dispatch-reconcile.ts`. Findings that change the design,
folded into the context and actor sections above:

- **One ambient authority read.** `authorizeDocumentAction` grants `owner`
  from `systemAuthorityFor(appId)`, an AsyncLocalStorage value only the
  server-function gateway sets. It must travel on `actor`, scoped to the
  app, and the executor refuses an actor whose app is not the call tenant.
- **Tenant as a value, admin partition as an argument.** The rate limiter
  writes `appId` into its row and takes the tenant from `TenantContext`
  with no `env` at all; the activity recorder's admin partition is
  `env.GLOBAL_ADMIN_APP_ID` (overridable by header only when local test
  routes are on), so `adminModels` is built for the partition the call
  names.
- **`fresh` is correctness, not performance.** Three of the five use a
  nested batch context to re-read after a lost conditional write.
- **Wire-format hazards, all findable.** `RateLimitResult.resetAt` is a
  `Date` and a caller calls `.getTime()` on it; the activity record carries
  `Date`s; reconcile returns the `WorkflowRun` model instance and the
  controller keeps using it. Procedures return plain views, with dates as
  epoch milliseconds and rows as `fromRemote` input.
- **Per-isolate gates move together or break.** The activity recorder's
  once-per-isolate-hour gate becomes once-per-executor-isolate-hour, which
  is safe because the conditional write bounds it, but `clearActivityEntry`
  and `storedActivityFields` in `admin-api.ts` read the same map and must
  become procedures with it. The memberships SWR cache is invalidated from
  nine controller sites per isolate; in the executor those invalidations
  only land if those mutations are procedures too, so the design names
  them.
- **Two of the five do not move whole.** Reconcile interleaves DynamoDB
  with Workflow-binding `status()` and `terminate()`, a DO notify, Analytics
  Engine and R2, exactly what `ctx` excludes: it splits into a read
  procedure (row, slice summary, newest invocation record) and a
  `needs-ledger` write procedure (settle row, claim slice, close step rows),
  with probe, terminate and notify staying in the dispatch DO between them.
  Settlement puts the output to R2 before the row write and the row's
  fields depend on the put's disposition, so the caller does the put and
  passes the stored-output fields in. The sync invoke path moves only its
  two limiter calls and the activity record; sandbox, token mint, secrets
  and the `finally` stay in the controller.
- **Nothing creates a logger**, and several modules write `console.*` on
  purpose to bypass `LOG_LEVEL`; those operator lines will now appear in
  the executor's logs under the same prefixes.

### What the spikes cannot answer

- **Real branch and item-size distributions.** The replicas run both ends
  of each branch; the weighting comes later from the Phase B
  instrumentation on real traffic.
- **Behavior of the product's actual code**, including anything the
  transcription missed (a cache hit the replica does not model, a write the
  reader overlooked). Mitigated by review of the replicas against the
  source, and closed in Phase B when each procedure is measured in place.
- **Room relocation**: what existing DOs do when the product unpins. That
  is a Phase C question and needs the product's namespace, not a spike.

## Implementation sequence

Three phases. Phase A is dynamo-bao alone and ships as a release. Phase B
is js-bao-wss adopting it, handed off with a written plan. Phase C is the
topology change and is a separate project gated on Phase B's measurements.

### Phase A: dynamo-bao (independent, test-first)

1. **Land the pending read-before-write work** in the mutation mixin, which
   is in flight in this working tree. Not a dependency, but it makes
   procedures shorter and the mixin should be stable before the remote
   module's examples are written against it.
2. **`procedures.js` and `context.js`** with tests against the existing
   test table: tenant entry, batch context, `fresh` capacity merge and
   cache priming.
3. **`codec.js`** with a test per field type, and `fromRemote` plus the
   detached guard on `BaoModel`.
4. **`executor.js`**, tested with in-process `Request`/`Response`:
   validation, scope, multi-call isolation, outcomes, capacity, placement
   echo, budget, ingress.
5. **`client.js`** with `remote` and `inProcess`, tested round trip through
   the executor.
6. **Example and tutorial**: `examples/cloudflare-remote-executor/` with a
   two-file worker (procedures and mount), a `wrangler.toml` with the
   placement line and a self-binding, and `tutorials/11-remote-procedures.md`.
7. **Release.** Semver minor. Nothing existing changes behavior.

Acceptance: a Node test that stands up the executor in process, registers
two procedures in two tenants, sends one envelope with both calls, and
asserts outcomes, capacity, isolation (a throw in one call does not affect
the other), and that a detached instance refuses to save.

### Phase B: js-bao-wss adoption (handoff plan)

The handoff to js-bao-wss is this section plus Spike results. It is
written so the first PR is mechanical and each later PR is one measured
consumer.

1. **Foundation PR.** Upgrade dynamo-bao. Add `src/procedures/index.ts`
   with an empty registry, `src/remote-executor.ts` with the context
   resolver and ingress check, the `/_data/call` route, the `DATA`
   self-binding and `DATA_BINDING_SECRET`, the ESLint restriction (warning
   level until Phase C), `inProcess` wiring in the test setup, and a probe
   procedure that returns its colo, and `runWithDynamoMetrics` around
   `handleDocumentSubscription`, `acceptHandshake`, and
   `validateDocumentAccess` so the DO paths finally have a product baseline
   (this is the one piece of Spike 2 that has to live in the product).
   Acceptance: a test calls the probe through `inProcess`; a deployed call
   from a Workflow on alpha returns `SEA`; the DO metrics appear in
   `WORKER_PERF`.
2. **First Workflow consumer: `dispatch-reconcile`.** Already remote,
   read-mostly, measurable with the existing Workflow metrics once
   `finalizeWorkflowPerf` is re-wired. Replay class `conditional`.
   Acceptance: per-reconcile DynamoDB wall time drops by the round count
   times the hop difference measured in Spike 1.
3. **Run-row settlement.** The first `needs-ledger` procedure. The marker
   is the run row's own state transition, guarded; the procedure is written
   so a replay observes the transition and returns the same result.
   Acceptance: the existing settlement tests pass through `inProcess`, plus
   a replay test that sends the same `operationId` twice.
4. **Rate limit and app activity** as procedures, called from the function
   invoke path where it runs remotely. Small, self-contained, replay
   `conditional`.
5. **`DocumentPermissionService` takes `ctx`.** The constructor change
   described above, with `systemAuthorityFor` replaced by `ctx.actor`. No
   behavior change; existing tests pass. This is the prerequisite for the
   subscribe procedure and is reviewable on its own.
6. **Subscribe procedure and cache seeding.** `document.subscribe@1`, the
   `DocumentPermissionCache` seed method and generation counter, push
   invalidation from `emitAccessDiff`, a stated stale-allow window.
   Measured against the step 1 baseline, which by then has had weeks of
   traffic. Acceptance: subscribe p50 within the range Spike 3's `remote`
   mode measured, and the revocation race test passes.
7. **Handshake and the remaining ConnectionWorker reads**, then
   `AgentSessionDO` and `CronTriggerDO`, one procedure per existing
   function, each measured. At the end of this step the ESLint restriction
   becomes an error.

### Phase C: topology (separate project)

Split edge and data workers, version the room namespace, unpin the edge,
A/B it the way #2862 did the original pin, with a rollback that re-pins
without losing rooms. Alpha is the rehearsal for the mechanics, not the
measurement: its traffic is too thin, so the go/no-go reads the Phase B
step 1 metrics from production. Gated on Phase B step 6's numbers and on
Spike 3's answer about how much the pinned topology is costing.

Before production, in addition: fault tests for lost responses after
commit, replay beyond ten minutes, permission revocation racing a mapping
create, concurrent tenants in one envelope, and a deployment-version
mismatch between a long-lived DO and a new executor.

## Open questions

- Should `ConnectionMapping` move into the room DO's SQLite first, which
  would remove the peer query and mapping create from the subscribe path
  regardless of this proposal?
- How does the durable step recorder want to buffer settles, if at all?
- Batch size, flush opt-out, and slow-call rules for the tick-coalescing
  transport, when it is built.
- How procedure argument schemas are published once edge and data bundles
  are separate deployables. A generated manifest of names, versions, and
  schemas is the obvious answer.
- Whether and when to revisit Appendix A.

## Appendix A: the deferred plan language

Preserved so the design is not lost. Not scheduled.

A plan is a JSON array of steps, each one of `find`, `batchFind`, `findBy`,
`query`, `queryAll` (with `maxPages`), `create`, `update`, `delete`, `call`
(a registered procedure), or `transact`. Arguments may reference earlier
steps with `{ "$ref": "stepId.path" }`; a reference is a dependency edge and
resolves to the step's `ok` value. `"after": [...]` adds an ordering edge
without a data dependency, and two writes to the same key without one are
rejected. `when` gates a step with the filter operator vocabulary evaluated
in memory on the executor, with its own defined semantics for absent versus
`null`; a predicate never sees an error object as a value.

Steps settle to tagged outcomes: `ok`, `skipped` (predicate false or a
dependency not `ok`), `error` (thrown and listed in the step's `capture`),
`incomplete` (a `queryAll` hit `maxPages`), or `unknown`. An uncaptured
error aborts further dispatch; steps already dispatched in the same level
run to completion and every started step's outcome is reported. A plan is
not a transaction; a `transact` step is, with items `create`, `update`,
`delete`, and `conditionCheck`, a `ClientRequestToken`, per-item
cancellation reasons mapped back to logical items, and eviction of affected
loader-cache entries. Compiling a transact item requires splitting
`_saveItem` and `delete` into a preparation phase and a send phase and
reusing defaults, timestamps, index keys, constraint rows, and guards.

The scheduler sorts the DAG into levels and runs each with
`Promise.allSettled` inside one `runWithBatchContext`, so finds in a level
coalesce. Level barriers extend the critical path when a short read shares
a level with a long `queryAll`; a ready-node scheduler would avoid that.
Reads in a plan are request-local memoization, not snapshot isolation.
`consistent: true` on a read is library work (`ConsistentRead` is not
exposed today) and is rejected on GSI queries.

The client builder gives every step an explicit id and builds predicates
from handles (`p.where(level).ne(null)`), so a `when` can only name steps
that exist. Capacity is reported per plan, not per step, because concurrent
steps overlap and coalesced BatchGets share capacity.

Why it was deferred: the interpreter, the predicate semantics, the outcome
model's interaction with authorization decisions, the codec rules, and the
transaction compiler are each real work, the executor's capability surface
becomes "any operation on any allowlisted model for any tenant," and in a
single-bundle repo the data worker deploy it avoids is not a separate
deploy. Revisit when callers show they need to compose loads without a
deploy, which is most likely after the worker split.
