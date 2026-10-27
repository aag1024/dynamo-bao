# Remote plan executor: one cross-region trip per logical operation

Status: proposal (2026-10-27). Nothing here is implemented.

## Summary

Durable Objects should live near users. DynamoDB lives in one region. Code that
runs a chain of dependent DynamoDB calls from a DO far from that region pays a
cross-region round trip per call, which is why js-bao-wss currently pins its
fetch handler to `aws:us-west-2` and, as a side effect, drags every DO to
Oregon as well.

This document proposes a complement to dynamo-bao: a stateless worker pinned
next to DynamoDB that accepts a *plan* describing a multi-step read/write
program, executes it with dynamo-bao under one batch context, and returns all
results in one response. A DO, Workflow, or unpinned worker makes one
cross-region trip per logical operation instead of one per DynamoDB call.

The library provides the executor, a dependency scheduler, a predicate
evaluator, result serialization, and a procedure registry. The application
provides the plans and the procedures.

The executor collapses N trips into 1. It never collapses 1 into 0. Per-message
hot paths still need a caller-side cache; the executor is what refreshes it.

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
rounds per path, from reading the code:

| Path | Serial rounds | Notes |
|---|---|---|
| WS subscribe, `ConnectionWorker.handleDocumentSubscription` | ~9 | No `runWithBatchContext` in the DO, so every `find` is a bare GetItem; `Document.find` runs twice |
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

## Platform constraints

Facts from Cloudflare documentation, checked 2026-10-27.

- Explicit region placement (`placement.region = "aws:us-west-2"`) maps to the
  data center with the lowest latency to that cloud region. It is mutually
  exclusive with Smart Placement.
- "Placement only affects the execution of fetch event handlers. It does not
  affect RPC methods or named entrypoints." The RPC docs add that with Smart
  Placement, the callee "will run locally, on the same machine" as the caller.
- Therefore the executor is reached by a service-binding `fetch()` to a worker
  with a fetch handler, never by an RPC method. Promise pipelining over RPC
  does not help here.
- Durable Objects accept a `locationHint` (`wnam`, `enam`, `weur`, ...), honor
  it only on first creation, and never move afterward.
- RPC serialization is capped at 32 MiB; irrelevant for HTTP bodies but a
  reminder to keep `return` sets small.

**Unverified assumption.** No doc sentence confirms that a service-binding
`fetch()` to a region-placed worker honors the region. The pattern the docs
recommend ("enable placement on your back-end Worker to invoke it close to
your database" via a service binding) implies it does. Verify with the
`cf-placement` response header before building anything else. Fallback: call
the data worker's own hostname with an internal auth header, which certainly
places, at the cost of a few milliseconds of edge overhead.

## Architecture

```
user ──ws──▶ edge worker (unpinned, near user)
                │  stub.fetch
                ▼
          ConnectionWorker / YjsRoom DO (created near user)
                │  env.DATA.fetch("/_internal/plan", plan)   ← one trip
                ▼
          data worker (placement.region = aws:us-west-2)
                │  dynamo-bao, runWithBatchContext, TenantContext
                │  N calls at ~17 ms each, parallel within a level
                ▼
          DynamoDB us-west-2
```

Two workers, as Cloudflare recommends for split edge and back-end logic:

- **Edge worker.** Unpinned. Owns the WebSocket upgrade, DO routing, and the
  DO class definitions. Has a service binding `DATA` to the data worker.
- **Data worker.** Pinned. Owns the HTTP app API (whose routes gain nothing
  from the executor and should stay next to DynamoDB) and the internal
  `/_internal/plan` route. Binds the DO namespaces through `script_name` so
  HTTP handlers can still reach rooms.

The executor is stateless. There is no executor DO; a location-hinted DO near
Oregon would be single-threaded per object and would have to be sharded, and
the `wnam` hint lands somewhere in western North America rather than next to
the table. A hinted DO remains a fallback if region placement over service
bindings turns out not to work.

## The plan

A plan is JSON. The client builder below produces it; the executor consumes
it. A request carries an array of plans (see "Multi-plan request"); the
common case is an array of one.

```json
{
  "id": "subscribe",
  "tenant": "app_123",
  "steps": [
    { "id": "direct",  "op": "find",     "model": "DocumentPermission", "key": ["doc_1", "user_9"] },
    { "id": "members", "op": "queryAll", "model": "AppMembership", "index": "membershipsForApp",
      "pk": "app_123", "sk": { "membershipKey": { "$beginsWith": "user_9#" } } },
    { "id": "groups",  "op": "query",    "model": "DocumentGroupPermission",
      "index": "groupPermissionsForDocument", "pk": "doc_1" },
    { "id": "doc",     "op": "find",     "model": "Document", "key": "doc_1" },
    { "id": "level",   "op": "call",     "proc": "docPermissionLevel",
      "args": { "direct": { "$ref": "direct" }, "members": { "$ref": "members" },
                "groups": { "$ref": "groups" }, "doc": { "$ref": "doc" }, "action": "content.read" } },
    { "id": "mapping", "op": "create",   "model": "ConnectionMapping",
      "data": { "connectionId": "c1", "userId": "user_9", "documentId": "doc_1", "appId": "app_123", "ttl": "..." },
      "when": { "level": { "$ne": null } }, "onConditionalError": "capture" }
  ],
  "return": ["level", "doc", "mapping"]
}
```

### Step operations

| op | Arguments | dynamo-bao call |
|---|---|---|
| `find` | `model`, `key` (string, array, or object id) | `Model.find` |
| `batchFind` | `model`, `keys[]` | `Model.batchFind` |
| `findBy` | `model`, `constraint`, `value` | generated unique-constraint lookup (2 internal rounds) |
| `query` | `model`, `index`, `pk`, optional `sk`, `filter`, `limit`, `startKey`, `loadRelated` | `Model.queryByIndex` |
| `queryAll` | as `query` | drains every page |
| `create` | `model`, `data` | `Model.create` |
| `update` | `model`, `key`, `data`, optional `condition` | `Model.update` with condition and relative counters |
| `delete` | `model`, `key`, optional `condition` | `Model.delete` |
| `call` | `proc`, `args` | a registered procedure |
| `transact` | `items[]`, optional `idempotencyKey` | one `TransactWriteItems` (see below) |

### References

Any string-valued argument may be `{ "$ref": "stepId" }` or
`{ "$ref": "stepId.field.path" }`. A reference to a step's result is a
dependency edge. A reference to a skipped or missing step resolves to `null`,
and a `find` whose key resolves to `null` is skipped rather than failed.

### Predicates

`when` uses the same operator vocabulary as dynamo-bao's `condition` and
`filter`: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$beginsWith`,
`$contains`, `$exists`, `$in`, `$and`, `$or`, `$not`. The left-hand side is a
path into prior results (`"level"`, `"direct.permission"`,
`"members.count"`). Evaluation is in memory on the executor; no DynamoDB
expression is built. A step whose `when` is false resolves to `null` and
every step that references it is skipped too.

Predicates on reads save capacity, not latency, when the read is keyed by a
known id. Predicates on writes are the point.

### Scheduling

The executor builds a DAG from references and predicates, sorts it into
levels, and runs each level with `Promise.all` inside one
`runWithBatchContext`. Within a level, `find` steps on the same model coalesce
into a single BatchGetItem through dynamo-bao's existing tick batching, and
queries run concurrently. Level N+1 starts when every step in level N has
settled. A plan's wall time is roughly `levels × 17 ms`.

### Error policy

Per step, `onError` is one of:

- `abort` (default): the plan stops, the response carries the failing step and
  the error, and no later level runs. Writes already applied are not rolled
  back; a plan is not a transaction.
- `capture`: the step's result is `{ "$error": { "name": "...", "message": "..." } }`
  and the plan continues. Dependents that reference the step see the error
  object; `when` predicates can test `"mapping.$error.name"`.

`onConditionalError: "capture"` is shorthand for capturing only
`ConditionalError` and `ItemNotFoundError`, which is the common case for
"create, and if it already existed that is fine".

### Transact step

A `transact` step groups several writes into one `TransactWriteItems` call,
so they apply all or nothing.

```json
{ "id": "commit", "op": "transact", "idempotencyKey": "run_42:settle",
  "items": [
    { "op": "update", "model": "DocumentCollection", "key": "col_1",
      "data": { "documentCount": "+1" }, "condition": { "documentCount": 7 } },
    { "op": "create", "model": "CollectionMembership", "data": { "...": "..." } },
    { "op": "conditionCheck", "model": "DocumentPermission", "key": ["doc_1", "user_9"],
      "condition": { "permission": { "$in": ["owner", "read-write"] } } }
  ],
  "when": { "level": { "$ne": null } },
  "onConditionalError": "capture" }
```

Items are `create`, `update`, `delete`, or `conditionCheck`. The first three
take the same arguments as the standalone ops. `conditionCheck` asserts a
condition on a row without writing it.

What it adds over a level of independent writes:

- **Atomicity across rows.** A counter and the row it counts, or a
  group-permission row and its revision, either both land or neither does.
- **`conditionCheck` items.** A write guarded by another row's state, checked
  by DynamoDB at commit time. This is the atomic cousin of `when`: a `when`
  predicate is evaluated on the executor against a snapshot a few
  milliseconds old, a condition check has no window.
- **Idempotency.** `idempotencyKey` maps to `ClientRequestToken`, which
  DynamoDB honors for ten minutes. A durable run that replays must not
  double-settle; js-bao-wss's `idempotent-transact.ts` exists for this.
- **Per-item failure reasons.** On cancellation the captured result carries
  `reasons[i].code` in item order, so a later `when` or the caller can tell
  which condition failed without a read.

Limits and costs, which are DynamoDB's own:

- At most 100 items and 4 MB per transaction. Write units are doubled per
  item.
- The same row cannot appear twice. The executor rejects a transact step
  whose items collide on a key rather than merging them.
- Transactions return no attributes. The step's result is `{ "applied": true }`
  or the captured error. A caller that needs the written rows adds a `find`
  in a later level, the same read-back dynamo-bao does for unique-constraint
  transactions.
- A model with unique constraints expands one logical write into several
  transaction items (the row plus its constraint rows). The executor counts
  the expanded items against the limit.

Use a transact step when an invariant spans rows or a write must be guarded
by another row atomically. Use a plain level when the writes are independent
and partial application is acceptable, such as a connection mapping.

The first version supports exactly what is listed here. `TransactGetItems`
for consistent multi-row snapshots, and an automatic read-back option, wait
for a consumer that needs them.

### Consistency

All reads in a plan share one loader cache, so a `find` after a `create` in
the same plan returns the written row, matching `runWithBatchContext`
semantics today. Reads do not see writes from other plans in flight. A step
may set `consistent: true` to request a strongly consistent read.

### Response

```json
{
  "results": {
    "level": "read-write",
    "doc":     { "$model": "Document", "data": { "_pk": "...", "_sk": "...", "...": "..." } },
    "mapping": { "$model": "ConnectionMapping", "data": { "...": "..." } }
  },
  "capacity": { "read": 6.5, "write": 1, "perStep": { "direct": { "read": 0.5 }, "...": {} } },
  "levels": 3,
  "ms": 41
}
```

Model instances are returned as their raw `_dyData`. Query results are
`{ items: [...], count, lastEvaluatedKey }` with each item in the same form.
Only steps named in `return` are serialized; everything else is executed and
discarded.

### Multi-plan request

The request body is `{ "plans": [ ... ] }` and the response is keyed by plan
id. Plans in one request run concurrently and are isolated from each other:

- **Separate tenants.** A plan names one tenant, and `TenantContext` is the
  executor's authorization boundary, so one plan never spans tenants. Two
  plans in one request can. The WebSocket handshake needs this: the `App`
  row lives in the admin tenant, `User` and `AppUser` in the app tenant.
- **Failure isolation.** An `abort` in one plan does not stop another. Each
  plan has its own loader cache, capacity total, and `return` set.
- **No cross-plan references.** A `$ref` resolves only within its plan.
  Work that needs an admin-tenant row to gate app-tenant steps belongs in a
  procedure declared with `scope: "both"`.

The reason to fix the array format now rather than later is the client
transport. In a follow-up, the transport collects every `run()` issued in
the same macrotask and sends them as one request, the same way dynamo-bao's
`find` batching coalesces into one `BatchGetItem`. A room that receives
three updates in one tick and queries peers for each sends one request, and
callers write nothing extra. That needs no server change once the format is
an array.

## Procedures

A procedure is an ordinary async function registered by name on the data
worker. It is the escape hatch for logic a JSON plan cannot express, and the
day-one migration unit: the first version of any hot path is a single `call`
wrapping the existing function body.

```ts
export const checkAndIncrement = defineProcedure({
  name: "rateLimit.checkAndIncrement",
  scope: "app",
  async run(ctx, { limitKey, windowStart, limit, ttl }) {
    const { RateLimitWindow } = ctx.models;
    const id = RateLimitWindow.makePrimaryId(limitKey, windowStart);
    const bump = () => RateLimitWindow.update(id, { count: "+1" },
                         { condition: { count: { $lt: limit } } });
    try { return ok(await bump()); }
    catch (e) { if (!(e instanceof ItemNotFoundError)) return denied(e); }
    try { return ok(await RateLimitWindow.create({ limitKey, windowStart, appId: ctx.tenant, count: 1, ttl })); }
    catch (e) { if (!(e instanceof ConditionalError)) throw e; }
    return ok(await ctx.fresh(bump));
  },
});
```

Properties:

- Runs on the executor inside the plan's batch and tenant context. Its
  DynamoDB calls cost the local rate and its `find`s coalesce with the
  plan's other reads in the same level.
- Addressed by name over the wire, never by code. Nothing executable crosses
  the service binding.
- Composes with declarative steps: it can take plan handles as arguments and
  its result can gate later steps.
- Calls other procedures as plain functions. There is no second RPC layer
  inside the executor.
- Is the versioning boundary. If edge and data workers are ever deployed
  separately, procedure names and argument shapes are the contract.

### Procedure context

```ts
interface ProcedureContext {
  models: AppModels;            // the plan tenant's dynamo-bao models, batching on
  adminModels?: AdminModels;    // only when the registry entry declares scope "admin" | "both"
  tenant: string;               // read-only
  requestId: string;
  logger: Logger;
  fresh<T>(fn: () => Promise<T>): Promise<T>;   // nested runWithBatchContext
  waitUntil(p: Promise<unknown>): void;         // deferred work next to DynamoDB
  config: ReadonlyEnvConfig;    // flags and settings, no bindings
}
```

Arguments that were plan handles arrive as hydrated model instances already in
the loader cache. Return values are walked once: `BaoModel` instances become
`_dyData`, everything else must be plain JSON.

Deliberately absent, and why:

- **DO namespaces and stubs.** A DO call from the executor is a cross-region
  hop back toward the user. Fan-out is the caller's job using rows the plan
  returned.
- **WebSocket sends, alarms, DO storage, the notifier.** The executor has no
  socket or object state.
- **Service bindings and the raw env.** Exposing bindings invites
  orchestration where only data access belongs. Needing one is a sign the
  work belongs on the caller.
- **Tenant switching at runtime.** Scope is declared at registration so the
  capability is visible in one place.

The test for anything added later: does it make DynamoDB round trips cheaper,
or does it make the executor a second application server? Only the first
belongs.

## Client API

```ts
import { plan } from "dynamo-bao/remote";

const p = plan({ tenant: appId, transport: env.DATA });

const direct  = p.find(DocumentPermission, [documentId, userId]);
const members = p.queryAll(AppMembership, "membershipsForApp", appId,
                  { membershipKey: { $beginsWith: `${userId}#` } });
const groups  = p.query(DocumentGroupPermission, "groupPermissionsForDocument", documentId);
const doc     = p.find(Document, documentId);
const peers   = p.queryAll(ConnectionMapping, "connectionsForDocument", documentId);
const level   = p.call(docPermissionLevel, { direct, members, groups, doc, action: "content.read" });
const mapping = p.create(ConnectionMapping,
  { connectionId, userId, documentId, appId, ttl },
  { when: { level: { $ne: null } }, onConditionalError: "capture" });

const r = await p.run({ return: { level, doc, peers, mapping } });
const docRecord = Document.fromRemote(r.doc);
```

- `plan({ tenant, transport })` returns a builder. Each step method returns a
  handle. Passing a handle as a key, as a `call` argument, or in `when`
  creates the dependency edge. `handle.ref("field")` extracts a field for use
  as a later key or value.
- `run({ return })` serializes, posts over the transport, and returns the
  named results plus consumed capacity. Capacity is fed into the caller's own
  batch-context accumulator if one is active, so metering keeps working
  across the hop.
- `Model.fromRemote(dyData)` hydrates a detached instance. `save()`,
  `update`, and `delete` on a detached instance throw with a message pointing
  at the plan API, so no DO accidentally opens a DynamoDB connection from the
  wrong region.
- `defineProcedure` returns a typed descriptor importable on both sides; the
  client uses only its `name` and types.

## Rules for callers

1. Put every read keyed by a known id in level 0 and let the executor run
   them in parallel. Gate a read only when it is genuinely expensive and
   usually unnecessary.
2. Use references, not predicates, for key dependencies.
3. Use predicates on writes. A wrong guess on a read costs capacity; on a
   write it costs correctness.
4. Name the return set. Ship back only rows the caller will use.
5. Do not send per-message checks through the proxy. Cache on the caller,
   refresh through a small plan, invalidate on push.
6. A plan that needs more than three or four levels is logic. Make it a
   procedure.

## Worked examples (js-bao-wss)

**WebSocket subscribe.** Today: authorization (3 serial rounds), mapping
create, a second `Document.find`, peer query, none batched. With the plan in
the client API section: level 0 is four finds and three queries in parallel,
level 1 is the pure `docPermissionLevel` call, level 2 is the gated create.
Nine serial rounds become one trip plus about 35 ms of executor time. This is
also a win in the pinned topology, where the same code costs about 150 ms
today, because the plan makes parallelism the default.

**Per-message access check.** Zero trips. The subscribe plan returned
`level`; the DO seeds `DocumentPermissionCache` from it and reads the cache per
message. A refresh plan reruns level 0 and the compute step when the TTL
lapses or when an access-diff broadcast from `emitAccessDiff` names this user
and document. Mapping TTL renewal rides on the refresh plan.

**Function invoke.** The reference-chain case:

```ts
const fn      = p.findBy(ServerFunction, "functionKeyPerApp", `${appId}#${functionKey}`);
const config  = p.find(ServerFunctionConfig, fn.ref("activeConfigId"));      // waits for fn
const members = p.queryAll(AppMembership, "membershipsForApp", appId,
                  { membershipKey: { $beginsWith: `${userId}#` } }, { when: needsMemberships });
const gate    = p.call(evaluateFunctionAccess, { fn, members, actor });
const slot    = p.call(checkAndIncrement, { spec: "function.invoke", id: { appId, functionKey } },
                  { when: { "gate.allowed": true, "fn.status": "active", config: { $exists: true } } });
```

The rate-limit dance runs as a procedure where each attempt costs 17 ms. From
a durable run this path drops from roughly 1.2 s to about 250 ms. From the
pinned HTTP handler, about 120 ms to about 80 ms from overlapping the
membership query with the function lookup.

**Durable step trace.** The recorder settles step N and opens step N+1 at the
same boundary as two awaited writes to different keys. One plan with both
writes runs them in parallel: one trip and 17 ms instead of two trips at 165
ms. Per step, about 330 ms down to about 180 ms.

## What changes in dynamo-bao

New module `src/remote/`, exported as `dynamo-bao/remote`:

- `executor.js`: `executePlans(plans, { manager, procedures, logger })`. Runs
  each plan concurrently in its own `runWithBatchContext` and
  `TenantContext.runWithTenant`. Per plan: validates, builds the DAG, runs
  levels, serializes results, reports capacity via `getBatchContextCapacity`
  per step.
- `transact.js`: builds `TransactWriteItems` from transact items, including
  the constraint-row expansion for unique-constraint models, and maps
  `CancellationReasons` back to item indexes. Depends on splitting
  `_saveItem` in the mutation mixin into a build phase (returns the update or
  put params) and a send phase. That split is useful on its own and is the
  largest single piece of library work here.
- `predicate.js`: in-memory evaluator for the `when` vocabulary. Shares the
  operator list with `filter-expression.js` but builds no expression strings.
- `procedures.js`: `defineProcedure`, `ProcedureRegistry`, and construction of
  `ProcedureContext`.
- `client.js`: `plan()` builder, handle objects, serialization, transport
  interface (`{ fetch(Request) }`, satisfied by a service binding), and
  capacity passthrough.
- `model.js` additions: `static fromRemote(dyData)` and a detached flag that
  makes mutation methods throw.
- `worker.js`: a reference fetch handler for `/_internal/plan` that
  applications mount on their pinned worker, with a pluggable auth check.

Size estimate: 800 to 1,200 lines plus tests, of which the `_saveItem` split
and `transact.js` are roughly a third. The uncommitted work that drops
read-before-write on `update` and `delete` is directly complementary: every
eliminated pre-read is one fewer level inside a plan.

In the first version: all step ops in the table including the minimal
`transact`, the multi-plan envelope, `capture` error policy, `fromRemote`
with the detached guard, and capacity passthrough.

Follow-ups, in likely order: the tick-coalescing client transport (client
only, no server change), `TransactGetItems`, an automatic read-back option on
`transact`, streaming responses, plan caching.

Out of scope: running plans against DynamoDB Local in the test suite beyond
what the executor needs for its own tests.

## Security and tenancy

- The plan route is internal. It accepts requests only through the service
  binding (or, in the hostname fallback, with a shared secret header). It is
  never mounted on a user-facing path.
- `tenant` on each plan is enforced by `TenantContext` on the executor, one
  context per plan, and references never cross plans. The caller cannot name
  a tenant it is not authorized for only because the caller is trusted code;
  this is the same trust boundary as the DO code that calls `withAppContext`
  today, moved one hop.
- Procedure scope (`app`, `admin`, `both`) is declared at registration and
  checked by the executor before the procedure runs.
- Model names and index names in a plan are validated against the registered
  model set before any DynamoDB call.

## Impact estimate

Assumptions: 17 ms per DynamoDB call from the data worker, 140 ms cross-region
round trip for a user in Europe. Halve the 140 ms term for a user in the US
East. All figures are estimates from round counts, not measurements.

| Operation | Pinned today | DOs near users, no executor | DOs near users, with executor |
|---|---|---|---|
| WS subscribe (9 rounds) | 153 ms + 140 ms frame RTT | 1,260 ms | ~293 ms |
| yjs update between two EU users | ~160 to 190 ms | 160 to 440 ms | ~25 ms on cache hit |
| GET /documents/:id (HTTP) | 174 ms | 280 ms | 174 ms (stays on the data worker) |
| Workflow framework overhead (51 calls) | 8,415 ms measured | 8,415 ms | ~1,000 to 2,000 ms |
| Durable function `ctx.db` call (3 rounds) | ~500 ms | ~500 ms | ~190 ms |

Three conclusions:

1. For HTTP routes the executor changes nothing. Keep them on the pinned data
   worker.
2. Workflows and durable runs are the no-risk first customer. They are already
   remote, already measured at the far-colo rate, and need no topology change.
   A 4 to 8x cut in their DynamoDB overhead comes from the executor alone.
3. The product win is realtime latency outside the US West, and it comes from
   unpinning the DOs. The executor is what makes unpinning affordable:
   subscribe stays flat instead of growing 8x, and update propagation between
   nearby users drops by roughly 150 ms.

## Rollout

1. **Verify the placement assumption** (about a day). A service-binding
   `fetch()` from an unhinted DO in Europe to the pinned worker, reading
   `cf-placement`. `tools/latency-lab` in js-bao-wss is already set up for
   this. Also wrap DO code paths in `runWithDynamoMetrics` so before and after
   are measurable; today they are not.
2. **Build `dynamo-bao/remote`.** Executor, scheduler, predicate evaluator,
   procedure registry, client builder, `fromRemote`, detached guard, capacity
   passthrough, reference worker route.
3. **Wire js-bao-wss.** A self service binding like `FUNCTION_GATEWAY`, the
   `/_internal/plan` route on the pinned worker, a procedure module per
   existing service. First consumers: `durable-step-trace`, the disabled-user
   probe, `dispatch-reconcile`, and run-row settlement, which is why
   `transact` with `idempotencyKey` is in the first version.
4. **Port ConnectionWorker.** Handshake and subscribe as plans; enable
   `DocumentPermissionCache` with push invalidation from `emitAccessDiff`.
5. **Split edge and data workers and unpin the edge.** A/B on alpha the way
   #2862 did the original pin, with the DO metrics from step 1 as the
   yardstick.

## Open questions

- Does a service-binding `fetch()` honor `placement.region`? (Step 1.)
- Should `queryAll` have a page cap inside the executor, given the
  1,000-subrequest ceiling per invocation? Probably yes, with the cap in the
  plan and `lastEvaluatedKey` returned on overflow.
- When the tick-coalescing transport lands, should a plan be able to opt out
  of coalescing, for a caller that wants its result before the tick ends?
  Probably a `flush: true` option; decide when the transport is built.
- How should procedure argument types be shared between edge and data
  bundles once they are separate deployables? A generated manifest of
  procedure names and schemas is the obvious answer; not needed while both
  are one bundle.
