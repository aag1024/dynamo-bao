# Spike 6: ambient context audit

Read-only notes on what the five services to be moved into procedures read
from module globals or `env`. Fill in per file; nothing in js-bao-wss changes.

All paths are under `/Users/adrian/Dropbox/projects/js-bao-wss/main/src/`.
Real locations differ from the design doc's names for two of the five:
run-row settlement lives in `server-functions/run-row-settlement.ts` (the
engine-side wrapper is `function-runs/server-function-settlement.ts`, and the
sync-invoke slot `finally` is in `app-api/controllers/functions-controller.ts`);
dispatch reconcile is `function-runs/dispatch-reconcile.ts` (there is no
`src/workflows/`).

How the ambient pieces work, once:

- `getAppModels(env)` / `getAdminModels(env)` (`models/index.ts:323,404`)
  build a fresh `initModels` instance per call (`:314`, "NO CACHING"). `env`
  is only read for `AWS_REGION`, `DYNAMODB_TABLE`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `MODEL_PREFIX_PK_MODE` (`:267-283`), each falling
  back to `process.env` (populated by `nodejs_compat`, `wrangler.toml:3-4`).
  App models have `tenancy.enabled`, so every call needs an ambient tenant
  from `TenantContext.runWithTenant` (`withAppContext`, `:434`); admin models
  run under `withAdminContext(globalAdminAppId)` (`:424`).
- `systemAuthorityFor` / `preAuthenticatedFor` (`auth/pre-authenticated-context.ts:318,334`)
  read an `AsyncLocalStorage` store (`:300`) that only the server-function
  gateway fills (`runPreAuthenticated`, `:306`). Fields: `appId`,
  `userContext`, `systemAuthority`, `hasCaller`, `agentDriven`,
  `functionPrincipal`, `assertedStep`, dispatch run id / deadline
  (`:192-296`, readers `:354-474`). An HTTP request never enters it.
- Loggers come from `createLogger(env, context)` (`logger.ts:28`), which
  reads `env.LOG_LEVEL` and `env.LOG_SILENCE_PATTERNS` (`:41,51`). Several
  modules bypass it and write `console.*` on purpose so `LOG_LEVEL` cannot
  hide operator lines.

| File | `getAppModels(env)` / `getAdminModels(env)` | `systemAuthorityFor` / `preAuthenticatedFor` | env-keyed caches | loggers | feature flags | other globals |
|---|---|---|---|---|---|---|
| `app-api/services/document-permission-service.ts` | `getAppModels(this.env)` at `:464,491,649,735`; never enters a tenant itself, assumes the caller's `withAppContext(appId)` (`:678`); `this.env` is the full worker `Env` (`:1,338`) | `systemAuthorityFor(appId)` `:391` short-circuits to `owner` before any row read | memberships SWR via `getCachedMemberships(this.env, appId, userId)` `:511` -> `app-config-cache.ts:264`; module globals `cacheSet`/`cacheSignature` `:102-103`, key `${appId}#${userId}` `:189`; invalidated per-isolate from `groups-controller.ts` (4 sites) and `collections-controller.ts` (5 sites) | none of its own; `drainMembershipsForApp` writes `console.warn` on the soft limit (`util/membership-drain.ts:82`) | `DB_PERF_CACHE_ENABLED`, `DB_PERF_CACHE_MEMBERSHIPS_ENABLED`, `DB_PERF_CACHE_MEMBERSHIP_{FRESH_MS,STALE_MS,MAX_ENTRIES}` (`app-config-cache.ts:107-117,164-167`) | `app-auth-service.ts:955,983` constructs it with `this.env \|\| globalThis.__currentEnv` (the global is never assigned anywhere in `src/`); DO caller caches the level in `DocumentPermissionCache` keyed `${userId}#${documentId}` under `DOC_PERF_CACHE_ENABLED` (`connection-worker.ts:479,2040`; `services/document-permission-cache.ts:32-54`) |
| `services/rate-limit.ts` | `getAppModels()` with NO env `:79,136,315` (table/region from `process.env`); tenant from `TenantContext.getCurrentTenant()` `:139`, throws `:141`; `appId` written into the row `:155,199` | none | none | none inside; callers log fail-open warns (`services/rate-limit-helpers.ts:98,139`) | none; `RATE_LIMITS` is a static module table (`config/rate-limits.ts:5`) | nested `runWithBatchContext` `:180,214,329` to escape the cached `ObjectNotFound` (= design's `ctx.fresh`); `Date.now()` `:429` sets the window; `crypto.subtle` `:413` |
| `services/app-activity-recorder.ts` | `withAdminContext(globalAdminAppId)` + `getAdminModels(env)` `:233-234,331-333`; partition is request-derived: `adminIdentityPartition(env, request)` reads header `X-Global-Admin-App-Id` / WS query, else `env.GLOBAL_ADMIN_APP_ID` (`auth/admin-partition.ts:32-41`) | not read here; the call site gates on `!preAuthenticatedFor(appId)` (`functions-controller.ts:526`) | `lastAttempts` `:160` and `attempts` `:172`, module globals keyed `${partition}:${appId}` `:184`; `claimActivitySlot` `:188` one attempt per isolate-hour; `clearActivityEntry` `:207` called from `admin-api.ts:813,8845`; `storedActivityFields` `:307` reads the same isolate's `attempts` (`admin-api.ts:4261-4290` depends on that) | `input.logger.debug` `:255,340` (caller's `createLogger`); `CONSOLE_AUDIT` `:69-71` writes `console.log/warn` directly `:244,260` | none | `new Date()` `:217` is the write's `lastActivityAt`; returns `Date` fields `:44-47` |
| `server-functions/run-row-settlement.ts` (+ `function-runs/server-function-settlement.ts`, sync path in `functions-controller.ts`) | `loadRow` `:365-369` and `writeRow` `:400-404`: `withAppContext(appId)` + own `runWithBatchContext` + `getAppModels(env)`; `findByRunId` unique-constraint lookup `:369` | sync path only: `preAuthenticatedFor(appId)` `functions-controller.ts:526` | `shouldRecordRefusal` (`functions-controller.ts:717`) -> module-global `refusalLines` Map, key `sliceId\|reason`, cap 4096 (`server-functions/slice-refresh-record.ts:80-96`) | `console.info/warn` operator lines `:451-537`; wrapper `console.*` (`server-function-settlement.ts:136-184,297-368`); sync path `this.logger` | none | R2 `env.WORKFLOWS_BUCKET` `:395` before the row write (`:477-500`); DO stub `env.WORKFLOW_DISPATCH_WORKERS` via `notifyDispatchTerminal` `:407-408` after it; `new Date()` `:208` for `endedAt`; sync path: `deferRequestWork` (`services/request-deferred-work.ts:28,64`, AsyncLocalStorage-carried `waitUntil`) `:729`, `this.env.JWT_SECRET` `:638`, `runInSandbox(this.env)` `:658`, `declaredSecretValues(this.env)` `:756`, slot release in `finally` `:761` -> `safeReleaseSlot` `:551` |
| `function-runs/dispatch-reconcile.ts` | `withAppContext(appId)` + `getAppModels(env)` `:536-537,883-884,1030-1031`; helpers re-enter per call: `readSliceSummary`/`claimSliceStalled` (`server-functions/slice-lease.ts:121-124,569-571`, `bypassCache`+`batchDelay:0` in own batch `:98`), `recordSliceResetByRunId` (`:429`), `searchNewestInvocationForRun` (`server-functions/invocation-log.ts:988,1018-1019`), `closeRunningStepRows` (`function-runs/durable-step-trace.ts:348,362`), `readWorkflowRunRowConsistently` (`function-runs/run-row-confirm.ts:78`, raw `GetCommand` ConsistentRead) | none | `emitDocumentEvent` with `awaitSignup: true` `:1184-1190` -> `resolveUserSignupEpochS` -> per-isolate `SwrCache` in a `WeakMap` keyed by the `env` object (`app-api/services/user-profile-cache.ts:109-114`) | `opts.logger?.info/warn/debug` `:834,1062,1220,1282,1325` (DO's `createLogger(env,"WorkflowDispatchDO")` `workflow-dispatch-do.ts:113`, or controller `this.logger`); `console.info/warn` `:677,687,698,899,996,1004,1059` | none; constant `DISPATCH_NOTIFY_TIMEOUT_MS` `:1097` | Workflow bindings `env.FUNCTION_DURABLE` / `env.PLATFORM_REINDEX` / `env.WORKFLOW_APP` (`function-runs/run-binding.ts:57-63`): `.get().status()` `:184-188,251-256`, `.terminate()` `:712-716,1043-1047`; DO `env.WORKFLOW_DISPATCH_WORKERS` + `getWorkflowDispatchDOId` (`do-routing.ts:63`) with `stub.fetch` raced at 500 ms `:1118-1131,1261-1265`; Analytics Engine `env.APP_METRICS_BY_TENANT_USER`, `env.ENVIRONMENT` (`doc-worker/analytics/events.ts:80,112`); R2 `env.WORKFLOWS_BUCKET` via `runOutputFieldsForWrite` `:819` (`server-functions/run-output-persist.ts:28`); `Date.now()` `:976` feeds the stall verdict |

Already known from the transcription on 2026-10-27:

- `rate-limit.ts` calls `getAppModels()` with no env and requires an ambient
  tenant from `TenantContext` (throws "must be used within withAppContext()").
- `document-permission-service.ts:391` reads `systemAuthorityFor(appId)` from
  an AsyncLocalStorage store (`src/auth/pre-authenticated-context.ts:334`).
- `app-activity-recorder.ts` gates on a module-global `Map`
  (`claimActivitySlot`, one attempt per isolate-hour per app) and runs under
  `withAdminContext(globalAdminAppId)`.
- `app-config-cache.ts` memberships cache is a per-isolate module global
  keyed `${appId}#${userId}`, enabled only by `DB_PERF_CACHE_ENABLED` and
  `DB_PERF_CACHE_MEMBERSHIPS_ENABLED` (dev and alpha only).

All four confirmed at the lines cited in the table.

## Findings

### (a) Must be passed explicitly in the call or `ctx`

- **System authority.** `authorizeDocumentAction` decides `owner` from
  `systemAuthorityFor(appId)` (`document-permission-service.ts:391`) before
  any row read. The store is filled only inside the gateway's dispatch, so a
  procedure called from the gateway loses it unless the envelope's `actor`
  carries `systemAuthority` scoped to the app. Fail-closed direction holds if
  the field is absent (`pre-authenticated-context.ts:334-339`).
- **Tenant.** Every service assumes an ambient tenant and never sets one
  itself except the recorder (admin partition) and reconcile/settlement
  (which re-enter `withAppContext(appId)` per helper). `ctx.tenant` covers
  the app case; the rate limiter additionally writes `appId` into the row
  (`rate-limit.ts:155,199`), so it needs the tenant as a value, not only as a
  context.
- **Admin partition.** The recorder's partition comes from the request
  (`adminIdentityPartition`: header, WS query param, else
  `env.GLOBAL_ADMIN_APP_ID`). `adminModels` on `ctx` must be built for the
  partition the caller names, so the call must carry `globalAdminAppId`; a
  fixed executor-side default would make the `X-Global-Admin-App-Id`
  override silently stop working.
- **Logger.** None of the five creates a logger; each receives one or
  writes `console.*`. `ctx.logger` must exist and carry at least
  `info/warn/debug/error` with the `(message, detail)` signature the services
  use; the `requestId`/app context the caller's logger prefixed is lost
  unless the envelope carries it.
- **Deferred work.** The sync invoke path parks `recordInvocationLog` on
  `deferRequestWork` (AsyncLocalStorage-carried `waitUntil`,
  `request-deferred-work.ts:28,64`). Inside a procedure that is `ctx.waitUntil`;
  the executor must actually hold the promise, since a 30 s cap shorter than
  the invocation-log write plus `declaredSecretValues` would drop records.
- **Clock.** Rate windows (`rate-limit.ts:429`), `lastActivityAt`
  (`app-activity-recorder.ts:217`), `endedAt` (`run-row-settlement.ts:208`)
  and the stall verdict (`dispatch-reconcile.ts:976`) all use the executor's
  clock. Acceptable, but tests that pin `now` (reconcile's `opts.now`,
  `settleRetiredWorkflowRun`) need it as an argument.
- **Wire-format hazards.** `RateLimitResult.resetAt` is a `Date`
  (`rate-limit.ts:11`); `reserveInvocationSlot` calls `resetAt.getTime()`
  (`server-functions/rate.ts:52`) and will throw on the JSON string.
  `ActivityRecord.fields` are `Date`s (`app-activity-recorder.ts:44-47`),
  merged into the admin response at `admin-api.ts:4277`. `ReconcileResult.row`
  is the `WorkflowRun` instance returned by `update`/`find`
  (`dispatch-reconcile.ts:587,683,693,855,1068`) and the controller uses it
  as `existingRun` downstream (`functions-controller.ts:2458`), so it needs
  `Model.fromRemote`. Test seams `probeOverride`, `beforeStallClaim`,
  `beforeStallRowWrite` (`:913-927`) are functions and cannot cross.
  Everything else returned is plain (`AuthzDecision`, `RunRowSettleOutcome`
  string union). Errors thrown are plain `Error`s with message text; dynamo-bao
  `ConditionalError`/`ItemNotFoundError` are caught inside each service and
  never escape (`rate-limit.ts:168-339`, `app-activity-recorder.ts:250-262`,
  `run-row-settlement.ts:517`, `dispatch-reconcile.ts:496-502` matches by
  `name`, so a re-thrown copy would still classify).

### (b) Can be recomputed inside the data worker

- Models config: `AWS_REGION`, `DYNAMODB_TABLE`, credentials,
  `MODEL_PREFIX_PK_MODE` are the executor's own vars; `ctx.models` replaces
  all `getAppModels(env)` and env-less `getAppModels()` calls.
- `RATE_LIMITS` table and custom specs: static module data, or passed inline
  as a plain `{ name, limit, windowSeconds }` (the invoke path already does,
  `functions-controller.ts:483-487`).
- Pure policy: `ACTION_POLICY`, `selectEffectiveGrant`,
  `decideFunctionRunRowSettlement`, `activityCondition`,
  `decideFunctionRunStall`, `reconcileFailureMessage`, `isConditionalError`,
  `isTransactionConflict` are all pure over row data.
- The nested-batch "re-read after a lost conditional write" pattern
  (`rate-limit.ts:180,214,329`; `run-row-settlement.ts:367,402`;
  `slice-lease.ts:98`) is exactly `ctx.fresh`; nothing ambient is needed as
  long as `fresh` gives a new loader cache.
- `DB_PERF_CACHE_*` and the memberships SWR cache: the executor's own copy
  of `ReadonlyEnvConfig` can hold the flags; see (c) for what changes.
- `env.LOG_LEVEL` / `LOG_SILENCE_PATTERNS` for the executor's logger.

### (c) Per-isolate state whose semantics change in a different worker

- **Activity gate** (`lastAttempts`/`attempts`, keyed partition+app). Today:
  one attempt per app per hour per caller isolate, across many isolates.
  In the executor: one per app per hour per executor isolate, shared by every
  caller. Correctness still rests on the conditional write
  (`activityCondition`, `:135-152`), so fewer attempts is safe. Two couplings
  break: `clearActivityEntry` from `admin-api.ts:813,8845` (owner-removal
  cut, #4122) clears the caller's map, not the executor's, so the next
  activity after a cut will not renew `expiresAt` until the hour passes; and
  `storedActivityFields` (`admin-api.ts:4281`) reads the same isolate's
  attempt, which no longer exists caller-side, so a PUT within the hour
  restates the pre-write `lastActivityAt`. Both need to move with the
  recorder (two more procedures or one with a `mode`).
- **Memberships SWR cache** (`app-config-cache.ts`, 4 s fresh / 5 s stale).
  Invalidation from group join/leave and collection mutations
  (`groups-controller.ts`, `collections-controller.ts`) is per-isolate
  today, so a 5 s stale read was already possible on other isolates. In the
  executor the cache is shared by all callers (higher hit rate), but the
  caller-side invalidations never reach it unless those mutations become
  procedures too; the bound stays the stale window.
- **`DocumentPermissionCache`** on the connection DO
  (`connection-worker.ts:479`, `DOC_PERF_CACHE_ENABLED`, set in no env per
  the design doc). Stays in the caller by construction; the procedure is its
  loader.
- **`refusalLines`** dedupe (`slice-refresh-record.ts:81`) decides whether a
  refused invocation is recorded; per caller isolate today. The decision is
  made before the deferred write, so it stays caller-side; if the record
  write becomes a procedure the executor would see every isolate's first
  refusal, which is more lines, not fewer.
- **User-profile signup cache** (`user-profile-cache.ts:109`, `WeakMap` keyed
  by the `env` object). Reached from reconcile's notify-timeout analytics
  emit. A fresh `env` object per executor request would defeat it; irrelevant
  if the emit stays caller-side, which (d) says it does.
- **`getModelsInstance` per call** (`models/index.ts:314`). Not a cache, but
  the executor's single `ctx.models` changes the cost profile: today every
  helper pays `initModels` again.

### (d) Cannot move; stays in the caller

- **Dispatch reconcile as a unit.** `reconcileWorkflowRun` interleaves
  DynamoDB with Workflow-binding calls: row read -> `instance.status()`
  probe -> slice/log reads -> `instance.terminate()` -> row write -> DO
  notify (and on timeout, Analytics Engine). The bindings
  (`FUNCTION_DURABLE`, `WORKFLOW_APP`, `PLATFORM_REINDEX`,
  `WORKFLOW_DISPATCH_WORKERS`, `APP_METRICS_BY_TENANT_USER`) are exactly what
  `ctx` excludes. Movable pieces: "read row + slice summary + newest
  invocation record" (one read procedure returning plain views) and "settle
  row + claim slice + close step rows" (one `needs-ledger` write procedure).
  The probe, terminate and notify remain in the dispatch DO between them.
- **R2 output store before the row write** (`run-row-settlement.ts:477-500`,
  `WORKFLOWS_BUCKET`). The row's `output`/`outputR2Key`/`outputIncomplete`
  depend on the put's disposition, so either the caller does the put and
  passes `storedOutput` fields into the settle procedure, or the procedure
  gets an R2 binding, which the design rules out. Same for
  `runOutputFieldsForWrite` in reconcile (`:819`).
- **Terminal notify** (`notifyDispatchTerminal`, DO stub + 500 ms race) runs
  after a settled write; the caller does it from the procedure's `"settled"`
  outcome.
- **Sync invoke path.** The sandbox (`runInSandbox(this.env)`, Worker
  Loader), `JWT_SECRET` token mint, `declaredSecretValues`, and the
  `finally` that decides `spent` stay in the controller. Only the two
  limiter calls (reserve with `failClosed`, release) and the activity record
  move; the `preAuthenticatedFor(appId)` gate at `:526` is evaluated
  caller-side and passed as a boolean or folded into `actor`.
- **`adminIdentityPartition`** reads the request; the value moves, the read
  does not.
- **`DocumentPermissionCache`** and the WS-side `withAppContext` wrapper in
  `connection-worker.ts`.

## Implications for `ProcedureContext` and `actor`

`actor` needs:

- `kind`: `"user" | "system" | "admin"` plus `userId` (attribution; the
  rate-limit id and activity source already carry their own ids as args).
- `systemAuthority: boolean` scoped to `appId` — the one ambient read inside
  the five (`document-permission-service.ts:391`). The executor should refuse
  an actor whose `appId` differs from `tenant` rather than fall back.
- `preAuthenticated: boolean` (or `hasCaller`) so the activity recorder's
  "a person started it" gate (`functions-controller.ts:526`) can be decided
  in-procedure when reserve+record become one call. The other store fields
  (`agentDriven`, `functionPrincipal`, `assertedStep`, dispatch run id and
  deadline) are not read by these five and can wait.

`ctx` needs:

- `tenant` as a value (rows store `appId`), and `adminModels` built for a
  caller-supplied `globalAdminAppId` when scope is `admin`, not for a fixed
  executor default.
- `logger` with `info/warn/debug/error(message, detail?)`, pre-bound to
  `requestId` and tenant, and a stated policy for the `console.*` operator
  lines (they will now appear in the executor's logs; the greppable prefixes
  `[app-activity]`, `[function-run-settle…]`, `[dispatch]` are what operators
  search for).
- `fresh` as specified (new loader cache, capacity merged) — three of the
  five depend on it for correctness, not performance.
- `waitUntil` that the executor really awaits past the response, for the
  invocation-log write.
- `now(): number` or an explicit `now` argument convention, since four of
  the five stamp or compare wall time.
- `config` must expose `DB_PERF_CACHE_*` and nothing binding-shaped; the
  memberships cache then lives in the executor and the design should say
  which mutations invalidate it (group join/leave, collection grants) and
  that they must be procedures for the invalidation to land.
- Return-value rule: procedures return plain views, never `Date` or model
  instances. Concretely `resetAt`, `lastActivityAt`, `expiresAt` as epoch ms
  or ISO strings, and reconcile's `row` as `Model.fromRemote` input.
- A declared place for per-isolate gates (`claimActivitySlot`,
  `clearActivityEntry`, `storedActivityFields`) so they move together; two
  of the three are called from `admin-api.ts`, not from the recorder's own
  call sites.
