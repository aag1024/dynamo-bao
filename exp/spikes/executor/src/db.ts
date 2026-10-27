// How the spike reaches DynamoDB: the same way js-bao-wss does
// (src/models/index.ts there), transcribed 2026-10-27.
//
//   - initModels is called fresh on every use, inside the tenant context,
//     because ModelManager keys its instance on the current tenant.
//   - Tenancy is on for app models (tenant = appId, prefixed into every
//     key) and off for admin models.
//   - Credentials: dynamo-bao's client reads process.env, which nodejs_compat
//     fills from the worker's secrets. The explicit assignment below is a
//     belt-and-braces for a compatibility date that does not populate it.
//   - MODEL_PREFIX_PK_MODE is "tenant-scoped", the value production is moving
//     to; it decides whether ServerFunction's bare `sfn` pk is tenant-prefixed.
import pkg from "dynamo-bao";
import { appModels, adminModels } from "./models.cjs";

const { initModels, TenantContext, runWithBatchContext } = pkg as any;

export interface DbEnv {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  DDB_TABLE: string;
  DDB_REGION: string;
}

// dynamo-bao's model methods come from mixins the JS classes do not declare
// to TypeScript, so model classes are typed `any` here; the names are checked.
export type AppModels = { [K in keyof typeof appModels]: any };
export type AdminModels = { [K in keyof typeof adminModels]: any };

function ensureProcessEnv(env: DbEnv) {
  const p = (globalThis as any).process;
  if (!p?.env) return;
  p.env.AWS_ACCESS_KEY_ID ||= env.AWS_ACCESS_KEY_ID;
  p.env.AWS_SECRET_ACCESS_KEY ||= env.AWS_SECRET_ACCESS_KEY;
}

function config(env: DbEnv, tenancy: boolean) {
  return {
    models: tenancy ? appModels : adminModels,
    aws: { region: env.DDB_REGION },
    db: { tableName: env.DDB_TABLE },
    keyMigration: { modelPrefixPkMode: "tenant-scoped" },
    logging: { level: "ERROR" },
    tenancy: { enabled: tenancy },
  };
}

/** js-bao-wss `getAppModels(env)`: must run inside `withApp`. */
export function getAppModels(env: DbEnv): AppModels {
  ensureProcessEnv(env);
  return initModels(config(env, true)).models;
}

/** js-bao-wss `getAdminModels(env)`: global, no tenant. */
export function getAdminModels(env: DbEnv): AdminModels {
  ensureProcessEnv(env);
  return initModels(config(env, false)).models;
}

/** js-bao-wss `withAppContext(appId, fn)`. */
export function withApp<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  return TenantContext.runWithTenant(appId, fn);
}

/** dynamo-bao's per-request batch context; the product wraps handlers in it. */
export function withBatch<T>(fn: () => Promise<T>): Promise<T> {
  return runWithBatchContext(fn);
}
