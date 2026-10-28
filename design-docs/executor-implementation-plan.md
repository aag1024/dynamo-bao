# Executor implementation plan (for review)

Status: draft for review, 2026-10-28. Companion to
`remote-procedure-executor.md`, which holds the design and the spike
results this plan is ordered by. Nothing here is started.

## What the spikes decided

- Service-binding `fetch()` to a region-placed worker runs in that region.
  RPC does not. Hostname fallback works for DO callers only.
- From the DO's current location every DynamoDB call costs about 42 ms,
  so a path costs its round-trip depth times that. From the data worker,
  12 ms. The hop from a far DO to the data worker is 150 to 175 ms and does
  not go cold.
- Restructuring the DO paths under a batch context halves them in place:
  subscribe 191 to 198 ms down to 80 to 86, per-message check 77 to 84 down
  to 39 to 44. The executor cannot beat that at the pinned location.
- Unpinning restructured code alone makes far users' subscriptions 310 to
  360 ms warm and 830 to 850 ms on a fresh DO. Through the executor, 210 to
  240 and about 250. The per-message check from a far DO is one far round
  either way unless the permission cache removes it.
- Workflow instances are not version-pinned; the registry serves the
  previous procedure version across a deploy window only.
- Two of the five services do not move whole (reconcile splits, settlement
  keeps its R2 put caller-side), and `ctx`/`actor` must carry system
  authority, tenant, admin partition, clock, logger and fresh re-reads.

## Sequence at a glance

Four workstreams. W1 and W2 can run in parallel; W3 needs W2 released and
W1's metrics; W4 needs W1, W2, W3 and a go decision.

| # | Workstream | Repo | Value when done | Gate to start |
|---|---|---|---|---|
| W1 | Restructure the DO paths in place | js-bao-wss | Halves subscribe and per-message cost for every user today | none |
| W2 | Executor library | dynamo-bao | A release with the executor, client, codec and tests | none |
| W3 | Executor for Workflows | js-bao-wss | Reconcile and settlement stop paying the far-colo rate per call | W2 released, W1 PR1 metrics live |
| W4 | Two-bundle split and unpinning | js-bao-wss | Realtime latency for users outside the US West | W1 done, W3 stable, go/no-go on production metrics |

## W1: restructure the DO paths in place (js-bao-wss)

Goal: Spike 3's `parallel` shape in the product, measured by the product.
No executor, no topology change. Each PR is reviewable alone and leaves
behavior unchanged.

| PR | Change | Acceptance |
|---|---|---|
| W1.1 Metrics | `runWithDynamoMetrics` around `handleDocumentSubscription`, `acceptHandshake` and `validateDocumentAccess`; per-call timing, serial depth and capacity into `WORKER_PERF`. This is the product baseline the spikes could not provide and the branch mix they could not know. | Metrics visible in production for a week before W1.2 lands; p50 and depth per path recorded in the design doc's impact table as "product, before". |
| W1.2 Batch context at the DO entry points | Wrap the subscription handler and the per-message path in `runWithBatchContext` inside `withAppContext`. Same-tick finds coalesce; the second `Document.find` becomes a loader-cache hit. | Existing tests pass; depth for subscribe drops by one in the metrics; no change in what is decided. |
| W1.3 Reads-then-decide in `DocumentPermissionService` | Add a `loadAuthReads(ids)` that issues the direct grant, memberships drain, group grants and document reads as promises, and a pure `decideLevel(reads)` with the existing logic, owner short-circuit included. `authorizeDocumentAction` calls both; the DO paths call `loadAuthReads` once per operation and reuse it. | Permission tests pass unchanged; subscribe depth 2 and per-message depth 1 in the metrics; read capacity per subscribe rises by at most the group query, stated in the PR. |
| W1.4 Batched writes after the decision | Mapping create and peer query issued together; handshake reads batched the same way. | Subscribe p50 in production near 80 to 86 ms from Los Angeles for non-owners; owner within 10 ms of that. |
| W1.5 Permission cache decision | Turn `DOC_PERF_CACHE_ENABLED` on in alpha behind the metrics; state the stale-allow window; run the revocation-race test. | Hit rate and staleness measured; a written decision on production. |

Risks: speculative reads cost capacity on the owner path (bounded by the
group query); the six-connection limit bounds how wide a `Promise.all`
really runs, so W1.3 issues at most four reads; a fresh DO still pays a
handshake per concurrent read, which is why W4 needs the executor.

## W2: executor library (dynamo-bao)

Goal: a semver-minor release with nothing existing changing behavior.
Test-first against the existing test table. Shapes are the ones the
design doc fixed after Spike 6.

| PR | Change | Acceptance |
|---|---|---|
| W2.1 `context.js` | `createContext`: tenant entry, batch context, `tenant` as a value, `now()`, logger bound to requestId and tenant, `fresh` with capacity merge and cache priming, `waitUntil` that is awaited past the response, `adminModels` built for the envelope's admin partition. | Unit tests for each field; `fresh` test asserts merged capacity and primed cache. |
| W2.2 `codec.js` and `fromRemote` | Encode and decode per field type; `StringSetField` to array and back (the only non-JSON field found across 81 models); dates as epoch ms; `Model.fromRemote` returning a detached instance whose guarded methods throw. | One test per field type; a detached instance refuses to save. |
| W2.3 `procedures.js` | Registry: name, version, scope, replay class, arg schema; previous-version serving across a deploy window; unknown procedure and scope refusal. | Registry tests. |
| W2.4 `executor.js` | Envelope validation, actor check (actor app must equal the call tenant), multi-call isolation, tagged outcomes, capacity and placement echo, budget and ingress refusal, plain-view return rule enforced (a `Date` or model instance in a result is an error in tests). | In-process `Request`/`Response` tests; a throw in one call does not affect another. |
| W2.5 `client.js` | `remote(transport, { actor })` and `inProcess`; `unknown` on transport failure; no auto-resend for `needs-ledger`. | Round trip through the executor in process. |
| W2.6 Example and tutorial | `examples/cloudflare-remote-executor/` with a placed data worker and a binding; `tutorials/11-remote-procedures.md`. | Dry-run deploy bundles; tutorial walks the subscribe example. |
| W2.7 Release | Changelog, tag. | Acceptance test from the design doc passes end to end. |

## W3: executor for Workflows (js-bao-wss)

Goal: the first real consumers, chosen because they are already remote and
already measured at the far-colo rate. Each PR is one procedure, measured.

| PR | Change | Acceptance |
|---|---|---|
| W3.1 Foundation | Upgrade dynamo-bao; empty registry in `src/procedures/`; `src/remote-executor.ts` with the context resolver (actor from the gateway's pre-authenticated store, admin partition from `adminIdentityPartition`) and ingress check; `/_data/call` route; `DATA` self-binding and secret; ESLint restriction at warning level; `inProcess` in test setup; a probe procedure returning its colo. | Probe through `inProcess` in tests; a deployed call from a Workflow on alpha returns `SEA`. |
| W3.2 Reconcile, split | `workflowRun.reconcileRead@1` (row, slice summary, newest invocation record, as plain views) and `workflowRun.reconcileSettle@1` (`needs-ledger`: settle row, claim slice, close step rows). The probe, terminate and DO notify stay in the dispatch DO between them. `ReconcileResult.row` becomes `fromRemote` input. | Existing reconcile tests pass through `inProcess`; per-reconcile DynamoDB wall time drops by rounds times the Spike 1 hop. |
| W3.3 Run-row settlement | `functionRun.settle@1`, `needs-ledger`, with the caller doing the R2 put and passing `storedOutput` fields in; terminal notify stays caller-side on the `settled` outcome. | Settlement tests through `inProcess`; a replay test sends the same `operationId` twice. |
| W3.4 Rate limit and activity | `rateLimit.reserve@1` / `release@1` and `app.recordActivity@1` with the gate helpers `clearActivityEntry` and `storedActivityFields` moved alongside; `resetAt` as epoch ms with the one caller fixed. | Invoke path tests pass; admin-API tests for the activity fields pass. |

## W4: two-bundle split and unpinning (js-bao-wss)

Goal: DOs near users. Separate project with its own go/no-go.

| PR | Change | Acceptance |
|---|---|---|
| W4.1 Two bundles | Edge worker (WebSocket upgrade, DO routing, DO classes, no DynamoDB credentials) and data worker (HTTP app API, executor, placement line), DO namespaces bound back through `script_name`; deploy data first, edge second, from one script. Edge still pinned at this point. | Both deploy; everything behaves as before; a version-skew test across the deploy window. |
| W4.2 Subscribe procedure | `document.subscribe@1` from W1.3's reads-then-decide functions; `DocumentPermissionCache` seeding and generation counter; push invalidation from `emitAccessDiff`; stale-allow window from W1.5. | Subscribe p50 within Spike 3's `remote` range for the edge's colo; revocation race test passes. |
| W4.3 Remaining DO procedures | Handshake and remaining ConnectionWorker reads, `AgentSessionDO`, `CronTriggerDO`; ESLint restriction to error. | Each measured against W1.1's baseline. |
| W4.4 Unpin and A/B | Version the room namespace, unpin the edge, A/B the way #2862 did the pin, rollback that re-pins without losing rooms. Alpha rehearses the mechanics; production metrics decide. | Far-region subscribe p50 near 220 to 250 ms; no regression for US West users; rollback exercised. |

Before production, in addition: fault tests for lost responses after
commit, replay beyond ten minutes, permission revocation racing a mapping
create, concurrent tenants in one envelope, and a deployment-version
mismatch between a long-lived DO and a new executor.

## Decisions to make in review

1. Confirm the order: W1 before any executor consumer in js-bao-wss. The
   alternative, shipping W3 first, delays the only win available to every
   user today.
2. W1.5: is turning the permission cache on acceptable, and with what
   stale-allow window? It is the only lever that takes the per-message
   check to zero from a far DO.
3. Should `ConnectionMapping` move into the room DO's SQLite before W4.2?
   It would remove the peer query and mapping create from the subscribe
   path regardless of the executor.
4. W3 scope: reconcile and settlement only, or also the invoke-path rate
   limit and activity (W3.4)? The latter is small but touches the admin
   API's activity helpers.
5. Who owns W1 and W3 in js-bao-wss, and whether W2 is one release or two
   (context and codec first, executor and client second).

## Risks

- W1.3 changes the permission service's structure; a logic slip there is a
  security bug. The pure decision function keeps the existing tests
  meaningful, and the metrics' depth numbers show whether the reads really
  went out together.
- Plain-view return values touch three callers that use `Date` or model
  instances today; each is listed in the Spike 6 audit.
- Per-isolate gates and cache invalidations that stay behind silently stop
  working; the audit lists the nine invalidation sites and the two
  activity helpers.
- W4's fresh-DO cost through the executor is about 250 ms, the floor; it
  will not go lower without a caller-side cache.

## Teardown

The spike resources (three workers, a DO namespace, a Workflow, the
`executor-spike` table and its IAM user) stay deployed only while something
still needs measuring. `exp/spikes/executor/teardown.sh --yes` removes
them and verifies nothing is left.
