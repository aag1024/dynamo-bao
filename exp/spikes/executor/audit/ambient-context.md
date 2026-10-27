# Spike 6: ambient context audit

Read-only notes on what the five services to be moved into procedures read
from module globals or `env`. Fill in per file; nothing in js-bao-wss changes.

| File | `getAppModels(env)` / `getAdminModels(env)` | `systemAuthorityFor` / `preAuthenticatedFor` | env-keyed caches | loggers | feature flags | other globals |
|---|---|---|---|---|---|---|
| `src/app-api/services/document-permission-service.ts` | | | | | | |
| `src/services/rate-limit.ts` | | | | | | |
| `src/services/app-activity-recorder.ts` | | | | | | |
| `src/function-runs/run-row-settlement.ts` (or wherever settlement lives) | | | | | | |
| `src/workflows/dispatch-reconcile.ts` (or wherever) | | | | | | |

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

Decision this feeds: the final shape of `ProcedureContext` and `actor` in
`design-docs/remote-procedure-executor.md`.
