# Remote plan executor: one cross-region trip per logical operation

Status: proposal (2026-10-27, revised the same day after an independent
review). Nothing here is implemented. See "Open decision: v1 scope" before
reading the rest as settled.

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

## Open decision: v1 scope

An independent review (Codex, 2026-10-27) agreed that moving dependent
DynamoDB work next to the table is the right move and disagreed with
shipping the declarative plan language as the first version. Its argument:
named, typed procedures over a service-binding `fetch()` deliver the whole
network benefit with ordinary JavaScript for branching, dependencies, and
error handling, and the plan language, scheduler, predicate evaluator, codec,
and transaction compiler are separate investments whose necessity no
consumer has yet demonstrated.

The two candidate v1 scopes:

- **Procedures-first.** A binding-only regional service, a handful of named
  and versioned procedures, batch and tenant contexts, bounded results,
  plan-level capacity totals, correlation ids. The declarative step language
  comes later, as a read-mostly subset, if real consumers show they compose
  ad hoc loads often enough to justify it.
- **Plan language in v1** as described below, with procedures as the
  escape hatch.

The rest of this document describes the full design so the second option is
specified. The rollout section is written so that its first three steps are
identical under either choice: the placement probe, the regional service,
and the first Workflow consumers need procedures only.

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
a batch context.

## Alternatives considered

| Alternative | Attractive for | Why not, or not yet |
|---|---|---|
| Typed procedures over service-binding `fetch()` | Immediate removal of remote orchestration latency with little infrastructure | This is the procedures-first v1 option above; it is a subset of this design, not a rejection of it |
| Keep everything pinned; batch and cache locally | Cheapest baseline, useful regardless | Keeps the geographic realtime penalty for every non-US-West user |
| DynamoDB Global Tables, read replicas with one write region | Read-heavy workloads needing local reads | Replication lag; writes stay remote; multi-region strong consistency mode does not support transactions, and multi-region eventual mode is last-writer-wins, which breaks unique-constraint rows and conditional counters |
| DO SQLite for room-local hot state | Connection mappings, presence, cached grants for one document | Worth doing for `ConnectionMapping`, which is queried by document and could live in the room DO; does not help global invariants or cross-object reads |
| D1 with read replication | SQL read models | Writes still go to the primary; a storage redesign, not a latency fix |
| Location-hinted executor DO near Oregon | If placement over service bindings turns out not to work | Single-threaded per object, needs sharding, `wnam` is not "next to the table" |

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
  behavior is proven.
- Therefore the executor is designed to be reached by a service-binding
  `fetch()` to a worker with a fetch handler. Promise pipelining over RPC is
  not relied on.
- Durable Objects accept a `locationHint` (`wnam`, `enam`, `weur`, ...), honor
  it only on first creation, and never move afterward. Unpinning the edge
  worker relocates nothing that already exists.
- Paid-plan limits: 10,000 subrequests per invocation (configurable), six
  connections simultaneously awaiting response headers (a seventh queues),
  30 s CPU by default and up to 5 minutes, 128 MB per isolate shared across
  concurrent requests, and `waitUntil` work runs for at most 30 s after the
  response. The six-connection limit bounds how wide a level can really be.
- RPC serialization is capped at 32 MiB; irrelevant for HTTP bodies but a
  reminder to keep `return` sets small.

**Unverified assumption.** No doc sentence confirms that a service-binding
`fetch()` to a region-placed worker honors the region. The probe in rollout
step 1 tests a self-binding, a separate-worker binding, an RPC method, and
the hostname fallback, from both a remote DO and a Workflow. The executor
should echo its own observed placement metadata and timing in the response
rather than relying on the `cf-placement` header alone, which the docs
describe as request metadata. The hostname fallback needs a custom domain
and its overhead is unmeasured.

## Architecture

```
user ──ws──▶ edge worker (unpinned, near user)
                │  stub.fetch
                ▼
          ConnectionWorker / YjsRoom DO (created near user)
                │  env.DATA.fetch("/plan", envelope)   ← one trip
                ▼
          data worker (placement.region = aws:us-west-2)
                │  dynamo-bao, runWithBatchContext, TenantContext
                │  N calls at ~17 ms each, parallel within a level
                ▼
          DynamoDB us-west-2
```

Two workers, as Cloudflare recommends for split edge and back-end logic:

- **Edge worker.** Unpinned. Owns the WebSocket upgrade, DO routing, and the
  DO class definitions. Has a service binding `DATA` to the data worker. Its
  bundle should carry no DynamoDB credentials, so the edge cannot reach the
  table except through the executor.
- **Data worker.** Pinned. Owns the HTTP app API (whose routes gain nothing
  from the executor and should stay next to DynamoDB) and the plan executor.
  Binds the DO namespaces through `script_name` so HTTP handlers can still
  reach rooms.

The executor should be a binding-only worker, or a route on the data worker
that is refused unless the request demonstrably arrived through the binding.
A path prefix is not an ingress boundary.

**Existing objects.** Moving DO class ownership to the edge worker and
unpinning does not move rooms that already exist near Oregon. The rollout
needs an explicit strategy: a new namespace version in the room name so that
documents reopened after the cutover land near their users, with the old
namespace drained over time. A shared room can only be near some of its
collaborators; the gain is for the common case of nearby collaborators.

## The plan

A plan is JSON. The client builder below produces it; the executor consumes
it. A request carries an envelope with a protocol version, an operation id,
and an array of plans (see "Multi-plan request"); the common case is an
array of one.

```json
{
  "v": 1,
  "operationId": "conn_c1:subscribe:doc_1",
  "actor": { "kind": "system", "appId": "app_123" },
  "plans": [{
    "id": "subscribe",
    "tenant": "app_123",
    "steps": [
      { "id": "direct",  "op": "find",     "model": "DocumentPermission", "key": { "documentId": "doc_1", "userId": "user_9" } },
      { "id": "members", "op": "queryAll", "model": "AppMembership", "index": "membershipsForApp",
        "pk": "app_123", "sk": { "membershipKey": { "$beginsWith": "user_9#" } }, "maxPages": 4 },
      { "id": "groups",  "op": "query",    "model": "DocumentGroupPermission",
        "index": "groupPermissionsForDocument", "pk": "doc_1" },
      { "id": "doc",     "op": "find",     "model": "Document", "key": "doc_1" },
      { "id": "level",   "op": "call",     "proc": "docPermissionLevel@1",
        "args": { "direct": { "$ref": "direct" }, "members": { "$ref": "members" },
                  "groups": { "$ref": "groups" }, "doc": { "$ref": "doc" }, "action": "content.read" } },
      { "id": "mapping", "op": "create",   "model": "ConnectionMapping",
        "data": { "connectionId": "c1", "userId": "user_9", "documentId": "doc_1", "appId": "app_123", "ttl": "..." },
        "when": { "level": { "$ne": null } }, "capture": ["ConditionalError"] }
    ],
    "return": ["level", "doc", "mapping"]
  }]
}
```

`actor` carries whatever ambient authority the application's code reads
today (in js-bao-wss, `systemAuthorityFor(appId)` and the caller's role).
Moving a function body behind the executor must not silently change what it
believes about who is calling; the envelope makes that explicit.

### Step operations

| op | Arguments | dynamo-bao call |
|---|---|---|
| `find` | `model`, `key` (string id or object of key fields) | `Model.find` |
| `batchFind` | `model`, `keys[]` | `Model.batchFind` |
| `findBy` | `model`, `constraint`, `value` | generated unique-constraint lookup (2 internal rounds) |
| `query` | `model`, `index`, `pk`, optional `sk`, `filter`, `limit`, `startKey`, `loadRelated` | `Model.queryByIndex` |
| `queryAll` | as `query` plus `maxPages` | drains pages up to `maxPages`; overflow is an explicit incomplete outcome, never a silently short list |
| `create` | `model`, `data` | `Model.create` |
| `update` | `model`, `key`, `data`, optional `condition` | `Model.update` with condition and relative counters |
| `delete` | `model`, `key`, optional `condition` | `Model.delete` |
| `call` | `proc`, `args` | a registered procedure, name suffixed with a version |
| `transact` | `items[]`, optional `idempotencyKey` | one `TransactWriteItems` (see below) |

Keys are strings or objects. dynamo-bao's `_parsePrimaryId` accepts exactly
those two forms; the client builder normalizes any convenience form before
serializing.

### Step outcomes

Every step settles to exactly one tagged outcome, and the distinction is
part of the protocol because callers make authorization decisions on it:

| Outcome | Meaning |
|---|---|
| `{ "ok": value }` | Ran and produced a value. For `find`, a missing row is `{ "ok": null }`, converted from dynamo-bao's `ObjectNotFound`. |
| `{ "skipped": true }` | Its `when` was false, or a dependency was not `ok`. |
| `{ "error": { "name", "message", ... } }` | Threw, and the error was in the step's `capture` list. |
| `{ "incomplete": { "lastEvaluatedKey" } }` | A `queryAll` hit `maxPages`. |
| `{ "unknown": true }` | A write was dispatched and the executor could not learn its result (transport error mid-flight). |

An uncaptured error aborts the plan; see "Error policy".

### References

An argument may be `{ "$ref": "stepId" }` or `{ "$ref": "stepId.path.to.field" }`.
Resolution is recursive through objects and arrays. A literal object that
needs a `$ref` key is escaped as `{ "$literal": ... }`. Path segments are
identifiers; a field containing a dot is addressed with a path array.

A reference is a dependency edge. It resolves to the step's `ok` value. If
the referenced step is not `ok`, the referencing step is `skipped`; a
procedure that wants to see a skipped or errored input declares it with
`{ "$outcome": "stepId" }`, which yields the tagged outcome and does not
cause a skip. A `find` whose resolved key is `null` is `skipped`.

Unknown step ids, duplicate ids, cycles, unknown return names, and paths
that touch prototype properties are validation errors, rejected before any
DynamoDB call.

### Ordering without a data dependency

"Create this row, then read it back by its literal key" has no `$ref`
between the two steps, and the executor would otherwise schedule both in
level 0. A step may declare `"after": ["stepId"]` for an ordering-only
edge. The executor also rejects a plan in which two write steps target the
same key without an ordering edge between them.

### Predicates

`when` uses the operator vocabulary of dynamo-bao's `condition` and
`filter`: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$beginsWith`,
`$contains`, `$exists`, `$in`, `$size`, `$and`, `$or`, `$not`. The left-hand
side is a path into a step's `ok` value. Evaluation is in memory on the
executor; no DynamoDB expression is built.

Sharing names with the filter builder does not make the semantics the same,
and the executor must define its own: a path into a non-`ok` step evaluates
as absent, `$exists: false` is true for absent and for `null`, comparisons
against absent are false, strings compare by code unit, dates compare as
ISO strings, and `$size` applies to arrays and strings. A predicate never
sees an error object as a value, so `{ "level": { "$ne": null } }` cannot be
satisfied by a captured error.

Predicates on reads save capacity, not latency, when the read is keyed by a
known id. Predicates on writes are the point. A `when` is a decision made
against reads that may be stale and mutually inconsistent; it is not a
commit-time guarantee. Where that matters, use a `conditionCheck` item in a
transact step.

### Scheduling

The executor builds a DAG from references, `after` edges, and predicates,
sorts it into levels, and runs each level with `Promise.allSettled` inside
one `runWithBatchContext`. Within a level, `find` steps on the same model
coalesce into a single BatchGetItem through dynamo-bao's existing tick
batching, and queries run concurrently up to the platform's six open
connections. Level N+1 starts when every step in level N has settled.

A level barrier means a short read that unlocks a write still waits for an
unrelated multi-page `queryAll` in the same level. A ready-node scheduler
would avoid that; levels are chosen for simplicity, and a plan that suffers
from this is a candidate for a procedure.

There is no fixed cost per level. A level containing a `findBy` is two
rounds, a `queryAll` is one round per page, and a procedure is whatever it
does. The useful mental model is "levels are the serial depth the plan
cannot avoid"; the executor reports actual per-level timing in the response.

### Error policy

Each step lists the error names it captures (`"capture": ["ConditionalError"]`).
A captured error becomes the step's `error` outcome and the plan continues;
dependents that reference it are skipped unless they asked for the outcome.
`capture` names specific errors on purpose: a lost conditional create, a
failed optimistic condition, and a missing row are different situations and
a caller should say which one is acceptable.

An uncaptured error aborts the plan:

- No further level is dispatched.
- Steps already dispatched in the same level run to completion. The
  executor waits for them and reports each one's outcome. Abort prevents
  future dispatch; it cannot cancel or undo a write that is in flight.
- Writes from earlier levels stay applied. A plan is not a transaction.
- The response carries the outcome of every step that started, so the
  caller knows exactly which sibling writes landed.

The caller's choices when a plan contains several writes:

- If two writes must land together, put them in one transact step.
- If partial application is acceptable, put them in a level.
- If the plan should react to one failing, capture it and gate a
  compensating write in a later level on `{ "$outcome": "x" }`. This is the
  only compensation mechanism offered.

### Transport failure and replay

A timeout after the executor has dispatched writes leaves the caller unable
to tell success from failure. The envelope's `operationId` is the unit of
replay. The executor records nothing durable about it in v1, so the rules
are the caller's:

- A plan with no writes is always safe to resend.
- A plan whose writes are all conditional state transitions (an
  `attribute_not_exists` create, an update guarded on the previous value) is
  safe to resend because the second attempt fails its condition and is
  captured as such.
- A plan with an unguarded write, or a counter, must not be resent blindly.
  Give it a transact step with an `idempotencyKey`, or make the write
  conditional.

Mutating procedures declare which of these classes they belong to at
registration, and the registry refuses to run an undeclared one.

### Transact step

A `transact` step groups several writes into one `TransactWriteItems` call,
so they apply all or nothing.

```json
{ "id": "commit", "op": "transact", "idempotencyKey": "run_42:settle:3",
  "items": [
    { "op": "update", "model": "DocumentCollection", "key": "col_1",
      "data": { "documentCount": "+1" }, "condition": { "documentCount": 7 } },
    { "op": "create", "model": "CollectionMembership", "data": { "...": "..." } },
    { "op": "conditionCheck", "model": "DocumentPermission", "key": { "documentId": "doc_1", "userId": "user_9" },
      "condition": { "permission": { "$in": ["owner", "read-write"] } } }
  ],
  "when": { "level": { "$ne": null } },
  "capture": ["TransactionCanceledException"] }
```

Items are `create`, `update`, `delete`, or `conditionCheck`. The first three
take the same arguments as the standalone ops. `conditionCheck` asserts a
condition on a row without writing it.

What it adds over a level of independent writes:

- **Atomicity across rows.** A counter and the row it counts, or a
  group-permission row and its revision, either both land or neither does.
- **`conditionCheck` items.** A write guarded by another row's state, checked
  by DynamoDB at commit time. Note that in js-bao-wss a document grant can
  come from a direct row, a group row, link access, or system authority, so
  guarding "the permission row" alone does not protect an authorization
  decision; guard the rows the decision actually depended on, or a
  maintained authorization revision.
- **Per-item failure reasons.** On cancellation the captured result carries
  `reasons[i].code` in logical item order, mapped back from the expanded
  physical items.
- **Idempotency within DynamoDB's window.** `idempotencyKey` maps to
  `ClientRequestToken` (36 characters maximum, honored for ten minutes,
  and only if the request is byte-identical). That protects a transport
  resend. It does not protect a Workflow replay an hour later, and a
  rebuilt request with a fresh timestamp or ULID fails with
  `IdempotentParameterMismatch` inside the window. Durable settlement needs
  a persisted marker or a conditional state transition in the transaction
  itself, and deterministic request construction. js-bao-wss's
  `idempotent-transact.ts` solves only the resend case.

Limits and costs:

- At most 100 items and 4 MB per transaction. Write units are doubled per
  item.
- The same row cannot appear twice. The executor rejects a transact step
  whose expanded items collide on a key.
- Transactions return no attributes. The step's result is `{ "ok": { "applied": true } }`
  or the captured error. The executor evicts every affected loader-cache
  entry, including unique-constraint rows, so a later `find` in the plan
  does not return a pre-transaction row; eviction followed by an eventually
  consistent read still does not guarantee read-your-write, so a caller that
  needs the row back uses `consistent: true` on the read.
- A model with unique constraints expands one logical write into several
  transaction items. The executor counts expanded items against the limit.

Compiling a transact item is more than splitting `_saveItem` into build and
send. A standalone write assigns defaults and timestamps, sometimes reads
the current row, computes index keys and iteration keys, adds constraint
rows, handles the key-migration modes, and adds its own guards; delete has
a separate constraint-cleanup path. The transaction compiler must reuse all
of that and map each failure back to its logical item. This is the largest
single piece of library work in the proposal.

Use a transact step when an invariant spans rows or a write must be guarded
by another row atomically. Use a plain level when the writes are independent
and partial application is acceptable, such as a connection mapping.

The first version supports exactly what is listed here. `TransactGetItems`
for consistent multi-row snapshots, and an automatic read-back option, wait
for a consumer that needs them.

### Consistency

All reads in a plan share one loader cache, so a `find` after a `create` in
the same plan returns the written row, as it does inside
`runWithBatchContext` today. This is request-local memoization, not snapshot
isolation: a cache miss or a query can observe another plan's committed
write, and a cache hit can return a value older than one. Nothing about the
executor makes a plan's reads mutually consistent.

A step may set `consistent: true`. That is library work, not an option
passthrough: `find`, `batchFind`, and the query builders do not expose
`ConsistentRead` today, a consistent read must bypass an earlier weak cache
entry, and a consistent `find` cannot join a weak BatchGet. The executor
rejects `consistent: true` on a GSI query, which DynamoDB cannot serve
consistently.

### Response

```json
{
  "v": 1,
  "placement": { "colo": "SEA", "region": "aws:us-west-2" },
  "plans": {
    "subscribe": {
      "steps": {
        "direct":  { "ok": { "$model": "DocumentPermission", "data": { "...": "..." } } },
        "level":   { "ok": "read-write" },
        "doc":     { "ok": { "$model": "Document", "data": { "...": "..." } } },
        "mapping": { "error": { "name": "ConditionalError", "message": "..." } }
      },
      "capacity": { "read": 6.5, "write": 1 },
      "levels": [ { "ms": 19 }, { "ms": 0 }, { "ms": 18 } ],
      "status": "ok"
    }
  }
}
```

Only steps named in `return` appear under `steps`. Model instances are
returned as `{ "$model", "data" }` where `data` is the row's `_dyData`
passed through a codec that handles binary fields, dates, and sets.
Explicitly loaded related objects are not included; a caller that wants a
related row names it as its own step. Query results are
`{ items: [...], count, lastEvaluatedKey }`.

Capacity is reported per plan. Per-step attribution is not offered, because
concurrent steps overlap in time and coalesced BatchGets share capacity
across steps; any per-step number would be an allocation rule, not a
measurement.

### Multi-plan request

The envelope carries an array of plans and the response is keyed by plan id.
Plans in one request run concurrently and are isolated from each other at
the level of exceptions, tenancy, and caches:

- **Separate tenants.** A plan names one tenant, and `TenantContext` is the
  executor's authorization boundary, so one plan never spans tenants. Two
  plans in one request can. The WebSocket handshake needs this: the `App`
  row lives in the admin tenant, `User` and `AppUser` in the app tenant.
- **Failure isolation.** An abort in one plan does not stop another. Each
  plan has its own loader cache, capacity total, and `return` set.
- **No cross-plan references.** A `$ref` resolves only within its plan.
  Work that needs an admin-tenant row to gate app-tenant steps belongs in a
  procedure declared with `scope: "both"`.

What the envelope does not isolate: the plans share one invocation's CPU
budget, memory, connection slots, and response. The slowest plan delays the
response for all of them, and an isolate failure takes all of them. The
executor enforces a per-request budget of steps, pages, and bytes, and
rejects an envelope that exceeds it.

The reason to fix the array format now is the client transport. In a
follow-up, the transport collects every `run()` issued in the same macrotask
and sends them as one request, the same way dynamo-bao's `find` batching
coalesces into one `BatchGetItem`. That follow-up needs a maximum batch size,
a `flush` opt-out, and a rule for a slow plan holding up its batch; none of
it needs a server change once the format is an array.

## Procedures

A procedure is an ordinary async function registered by name and version on
the data worker. It is the escape hatch for logic a JSON plan cannot
express, and the day-one migration unit: the first version of any hot path
is a single `call` wrapping the existing function body. Under the
procedures-first v1 option, it is the whole v1.

```ts
export const checkAndIncrement = defineProcedure({
  name: "rateLimit.checkAndIncrement",
  version: 1,
  scope: "app",
  replay: "conditional",   // every write is a guarded state transition
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

- Runs on the executor inside the plan's batch and tenant context. Its
  DynamoDB calls cost the local rate and its `find`s coalesce with the
  plan's other reads in the same level.
- Addressed by name and version over the wire, never by code. Nothing
  executable crosses the service binding. Versioning exists from day one
  because long-lived DOs and replayed Workflows will call into a newer
  deployment than the one that issued the plan.
- Declares its replay class (`read-only`, `conditional`, `needs-ledger`) so
  the transport-failure rules above can be enforced rather than assumed.
- Composes with declarative steps: it can take plan handles as arguments and
  its result can gate later steps.
- Calls other procedures as plain functions. There is no second RPC layer
  inside the executor.

### Procedure context

```ts
interface ProcedureContext {
  models: AppModels;            // the plan tenant's dynamo-bao models, batching on
  adminModels?: AdminModels;    // only when the registry entry declares scope "admin" | "both"
  tenant: string;               // read-only
  actor: Actor;                 // the envelope's actor, for code that read ambient authority
  requestId: string;
  logger: Logger;
  fresh<T>(fn: () => Promise<T>): Promise<T>;   // nested batch context; see below
  waitUntil(p: Promise<unknown>): void;         // deferred work next to DynamoDB, 30 s cap
  config: ReadonlyEnvConfig;    // flags and settings, no bindings
}
```

`fresh` runs `fn` in a nested `runWithBatchContext` for the
"re-read after a lost conditional write" pattern. A nested context has its
own loader cache and its own capacity accumulator, so `fresh` must merge
the nested capacity into the plan's total when it returns and prime the
outer cache with rows the nested work wrote. Without both, the plan
under-reports capacity and a later `find` returns a stale row.

Arguments that were plan handles arrive as hydrated model instances already in
the loader cache. Return values go through the same codec as step results.

**Scope is a convention for trusted code, not a capability boundary.**
`TenantContext.runWithTenant` sets an async-local value; a procedure that
imports a model class directly and calls it under a different context is
not stopped by anything. The registry checks the declared scope before
running a procedure and `adminModels` is only constructed for procedures
that declared it, which keeps the capability visible in one place. It does
not make the executor safe against a hostile procedure, and it is not meant
to.

Deliberately absent, and why:

- **DO namespaces and stubs.** A DO call from the executor is a cross-region
  hop back toward the user. Fan-out is the caller's job using rows the plan
  returned.
- **WebSocket sends, alarms, DO storage, the notifier.** The executor has no
  socket or object state.
- **Service bindings and the raw env.** Exposing bindings invites
  orchestration where only data access belongs. Needing one is a sign the
  work belongs on the caller.
- **Tenant switching at runtime.** Scope is declared at registration.

The reviewer's objection to this list is fair: authorization, rate limiting,
and settlement are application logic, and a deliberately scoped data
service is not made purer by pretending otherwise. The list is about where
network hops originate, not about keeping business logic out.

## Client API

```ts
import { plan } from "dynamo-bao/remote";

const p = plan({ tenant: appId, actor: systemActor(appId), transport: env.DATA });

const direct  = p.find("direct",  DocumentPermission, { documentId, userId });
const members = p.queryAll("members", AppMembership, "membershipsForApp", appId,
                  { membershipKey: { $beginsWith: `${userId}#` } }, { maxPages: 4 });
const groups  = p.query("groups", DocumentGroupPermission, "groupPermissionsForDocument", documentId);
const doc     = p.find("doc",     Document, documentId);
const peers   = p.queryAll("peers", ConnectionMapping, "connectionsForDocument", documentId);
const level   = p.call("level",   docPermissionLevel, { direct, members, groups, doc, action: "content.read" });
const mapping = p.create("mapping", ConnectionMapping,
  { connectionId, userId, documentId, appId, ttl },
  { when: p.where(level).ne(null), capture: ["ConditionalError"] });

const r = await p.run({ return: { level, doc, peers, mapping } });
if (r.level.ok == null) return deny(sender);
const docRecord = Document.fromRemote(r.doc.ok);
```

- Every step takes an explicit id as its first argument. The builder cannot
  infer a JavaScript variable name, and ids appear in the response and in
  logs.
- `p.where(handle)` builds predicates from handles (`eq`, `ne`, `gt`,
  `exists`, `path("allowed").eq(true)`, `and`, `or`), so a `when` can only
  refer to steps that exist. Passing a handle as a key, as a `call`
  argument, or in a predicate creates the dependency edge.
- `run({ return })` serializes, posts over the transport, and returns tagged
  outcomes keyed by the names given. Plan capacity is fed into the caller's
  own batch-context accumulator if one is active.
- `Model.fromRemote(row)` hydrates a detached instance from an `ok` model
  value. On a detached instance, `save`, `update`, `delete`,
  `loadRelatedData`, and `getOrLoadRelatedField` throw with a message
  pointing at the plan API. Static model methods are not guarded; the real
  boundary is that the edge bundle holds no DynamoDB credentials.
- `defineProcedure` returns a typed descriptor importable on both sides; the
  client uses only its name, version, and types.

## Rules for callers

1. Put every read keyed by a known id in level 0 and let the executor run
   them in parallel, within the six-connection limit. Gate a read only when
   it is genuinely expensive and usually unnecessary.
2. Use references, not predicates, for key dependencies, and `after` for
   ordering without one.
3. Use predicates on writes. A wrong guess on a read costs capacity; on a
   write it costs correctness.
4. Decide what partial failure means before writing two writes: transact,
   independent level, or capture plus compensate.
5. Name the return set. Ship back only rows the caller will use.
6. Do not send per-message checks through the proxy. Cache on the caller,
   refresh through a small plan, invalidate on push.
7. A plan that needs more than three or four levels is logic. Make it a
   procedure.

## Worked examples (js-bao-wss)

**WebSocket subscribe.** Today: authorization (up to 3 serial rounds), a
mapping create, a second `Document.find`, and a peer query, none batched. The
plan in the client API section has two finds and three queries in level 0,
a pure procedure in level 1, and one gated write in level 2: two I/O levels,
roughly 35 to 50 ms of executor time depending on membership page count.
Up to nine serial rounds become one trip plus that. The same restructuring
is a win in the pinned topology too, where the DO code pays the serial
rounds today, and that part needs no executor.

**Per-message access check.** Zero trips. The subscribe plan returned
`level`; the DO seeds `DocumentPermissionCache` from it (the class needs a
seed method; today it only has a loader callback) and reads the cache per
message. Refresh runs the level-0 reads and the compute step when the TTL
lapses or when an access-diff broadcast from `emitAccessDiff` names this
user and document.

The cache needs a revocation protocol, not just a flag: a maximum
stale-allow window stated as a product decision, a generation number on
each entry so a refresh started before a revocation cannot repopulate the
revoked grant, and a rule for reconnects and hibernation. The existing
cache's 4 s fresh / 5 s stale window is a starting point for the number.

**Function invoke.** The reference-chain case:

```ts
const fn      = p.findBy("fn", ServerFunction, "functionKeyPerApp", `${appId}#${functionKey}`);
const config  = p.find("config", ServerFunctionConfig, fn.ref("activeConfigId"));   // waits for fn
const members = p.queryAll("members", AppMembership, "membershipsForApp", appId,
                  { membershipKey: { $beginsWith: `${userId}#` } }, { when: needsMemberships });
const gate    = p.call("gate", evaluateFunctionAccess, { fn, members, actor });
const slot    = p.call("slot", checkAndIncrement, { spec: "function.invoke", id: { appId, functionKey } },
                  { when: p.where(gate).path("allowed").eq(true)
                           .and(p.where(fn).path("status").eq("active"))
                           .and(p.where(config).exists()) });
```

The rate-limit dance runs as a procedure where each attempt costs the local
rate. From a durable run this path drops from roughly 1.2 s to about 250 ms.
From the pinned HTTP handler the gain is only the overlap of the membership
query with the function lookup.

**Durable step trace.** The recorder settles step N when it returns and
opens step N+1 when it is invoked, as two awaited writes, and arbitrary user
code or a hibernation can sit between them. Merging them into one plan means
buffering the settle until the next open or the run's end, which changes
what an operator sees for a step that is sleeping. That is a recorder
redesign with a durability trade, not a transport change; the plan makes it
possible but does not make it free.

## What changes in dynamo-bao

New module `src/remote/`, exported as `dynamo-bao/remote`:

- `executor.js`: `executePlans(envelope, { manager, procedures, logger, budget })`.
  Validates the envelope, runs each plan concurrently in its own
  `runWithBatchContext` and `TenantContext.runWithTenant`, builds the DAG,
  runs levels with `allSettled`, applies the outcome rules, serializes
  results, reports plan capacity and per-level timing, echoes placement.
- `outcomes.js`: the tagged outcome types and the `ObjectNotFound` to `null`
  conversion.
- `predicate.js`: in-memory evaluator for the `when` vocabulary with the
  semantics defined above. Shares the operator list with
  `filter-expression.js` but not its implementation.
- `transact.js`: builds `TransactWriteItems` from transact items by reusing
  the mutation mixin's preparation (defaults, timestamps, index keys,
  constraint rows, guards), detects key collisions on expanded items, maps
  `CancellationReasons` back to logical items, and evicts affected cache
  entries. Depends on splitting `_saveItem` and `delete` into a preparation
  phase and a send phase.
- `procedures.js`: `defineProcedure` with name, version, scope, and replay
  class; `ProcedureRegistry`; construction of `ProcedureContext` including a
  `fresh` that merges capacity and primes the outer cache.
- `codec.js`: `_dyData` to JSON and back, covering binary, date, and set
  fields.
- `client.js`: `plan()` builder with explicit ids, handle-based predicates,
  serialization, the transport interface (`{ fetch(Request) }`), and
  capacity passthrough.
- `model.js` additions: `static fromRemote(row)`, the detached flag, and
  `ConsistentRead` support on `find`, `batchFind`, and the query builders.
- `worker.js`: a reference fetch handler that applications mount on a
  binding-only worker, with the ingress check pluggable.

The earlier estimate of 800 to 1,200 lines described a prototype of the
scheduler and client. With the outcome model, the predicate semantics, the
transaction compiler, the codec, consistent reads, versioning, and the
budget enforcement, the full contract is a multi-week library project. The
procedures-first option is the same executor, outcome model, registry,
codec, and worker route, without the scheduler, predicates, transaction
compiler, or client builder.

In the first version under the plan-language option: all step ops including
the minimal `transact`, the multi-plan envelope, tagged outcomes, `capture`,
`after`, `maxPages`, `fromRemote` with the detached guard, plan capacity,
versioned procedures, and the request budget.

Follow-ups, in likely order: the tick-coalescing client transport,
`TransactGetItems`, an automatic read-back option on `transact`, streaming
responses, plan caching.

Out of scope: running plans against DynamoDB Local in the test suite beyond
what the executor needs for its own tests.

## Security and tenancy

- The executor accepts requests only through the service binding. Under the
  single-worker layout, the route verifies that the request arrived through
  the binding and refuses public ingress, and that refusal is tested. Under
  the two-worker layout the executor worker has no public route at all.
- `tenant` on each plan is enforced by `TenantContext` on the executor, one
  context per plan, and references never cross plans. The caller can name
  any tenant only because the caller is trusted code; this is the same trust
  boundary as the DO code that calls `withAppContext` today, moved one hop.
  Tenant, model, index, operation, and procedure are validated together per
  step, against an allowlist, before any DynamoDB call. A global model
  allowlist with free tenant selection is a very broad capability, and the
  allowlist should be as narrow as the consumers permit.
- `actor` in the envelope is the only source of ambient authority inside the
  executor. Code moved behind a procedure reads `ctx.actor`, never a module
  global.
- Pagination keys are validated as belonging to the step's model and index.
- Protocol version `v` and procedure versions are in the format from the
  first deployment, with a documented compatibility rule: the executor
  serves the previous procedure version for one deployment cycle.

## Impact estimate

Assumptions: 17 ms per DynamoDB call from the data worker, 140 ms cross-region
round trip for a user in Europe. Halve the 140 ms term for a user in the US
East. All figures are estimates from round counts, not measurements, and the
DO paths have no baseline today. Replace this table with measured p50 and
p95 from rollout steps 1 and 3 before deciding step 5.

| Operation | Pinned today | DOs near users, no executor | DOs near users, with executor |
|---|---|---|---|
| WS subscribe (up to 9 rounds) | 150 ms + 140 ms frame RTT | up to 1,260 ms | ~180 to 200 ms |
| yjs update between two EU users | ~160 to 190 ms | 160 to 440 ms | ~25 ms on cache hit, room permitting |
| GET /documents/:id (HTTP) | 174 ms | 280 ms | 174 ms (stays on the data worker) |
| Workflow framework overhead (51 calls) | 8,415 ms measured | 8,415 ms | 870 ms of DynamoDB time plus 140 ms per irreducible boundary; the boundary count is unknown until the engine's bookkeeping is grouped |
| Durable function `ctx.db` call (3 rounds) | ~500 ms | ~500 ms | ~190 ms |

Three conclusions:

1. For HTTP routes the executor changes nothing. Keep them on the pinned data
   worker.
2. Workflows and durable runs are the first customer because they are
   already remote and already measured at the far-colo rate. They are not
   risk-free: settlement and replay are exactly where the replay rules above
   bite.
3. The product win is realtime latency outside the US West, and it comes
   from unpinning the DOs and relocating rooms. The executor is what makes
   unpinning affordable; the room relocation strategy is what makes it
   real.

## Rollout

Steps 1 to 3 are the same under either v1 scope.

1. **Prove placement and measure the baseline** (about a week). A probe
   worker with a fetch handler and an RPC entrypoint, pinned to
   `aws:us-west-2`, called from an unhinted DO in Europe and from a Workflow
   through a self-binding, a separate-worker binding, RPC, and the hostname
   fallback, cold and warm. Each response echoes its colo and DynamoDB
   timing. Separately, wrap DO code paths in `runWithDynamoMetrics` so the
   subscribe and per-message baselines exist.
2. **Build the regional service.** Executor, outcome model, registry with
   versions and replay classes, codec, worker route with ingress check,
   request budget. Under the plan-language option, add the scheduler,
   predicates, transaction compiler, and client builder.
3. **Wire js-bao-wss Workflows.** A service binding, a procedure module per
   existing service, an `actor` envelope. First consumers:
   `durable-step-trace` (after the recorder decision), the disabled-user
   probe, `dispatch-reconcile`, and run-row settlement, which is the first
   consumer that needs a durable replay marker and therefore the first real
   test of the replay rules.
4. **Port ConnectionWorker.** Handshake and subscribe as procedures or plans;
   `DocumentPermissionCache` with a seed method, generations, and push
   invalidation from `emitAccessDiff`; a stated stale-allow window.
5. **Split edge and data workers, version the room namespace, unpin the
   edge.** A/B on alpha the way #2862 did the original pin, with the DO
   metrics from step 1 as the yardstick and a rollback that re-pins without
   losing rooms.

Before production, in addition: fault tests for lost responses after
commit, replay beyond ten minutes, permission revocation racing a mapping
create, concurrent tenants in one envelope, `maxPages` overflow, and a
deployment-version mismatch between a long-lived DO and a new executor.

## Open questions

- Which v1 scope (see "Open decision: v1 scope").
- Does a service-binding `fetch()` honor `placement.region`? (Step 1.)
- Should `ConnectionMapping` move into the room DO's SQLite first, which
  would remove the peer query and mapping create from the subscribe path
  regardless of this proposal?
- How does the durable step recorder want to buffer settles, if at all?
- When the tick-coalescing transport lands, what are its batch size, flush
  opt-out, and slow-plan rules?
- How should procedure argument schemas be published once edge and data
  bundles are separate deployables? A generated manifest of names, versions,
  and schemas is the obvious answer.
