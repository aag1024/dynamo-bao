// A consumer written the way js-bao-wss will write it: its own model and env
// types, a context resolver, procedures and a caller. It must type-check
// against dynamo-bao/remote with no casts. Lines marked @ts-expect-error must
// fail to type-check; tsc reports an error if one of them does not.
import {
  createExecutor,
  defineProcedure,
  encodeValue,
  decodeRow,
  fresh,
  createContext,
  inProcess,
  remote,
  ProcedureRegistry,
  REPLAY_CLASSES,
  SCOPES,
  CodecError,
  type Actor,
  type ContextResolver,
  type ProcedureContext,
  type Outcome,
  type ReplayClass,
  type Scope,
  type EncodedRow,
  type ManifestEntry,
  type Transport,
} from "dynamo-bao/remote";

// The consumer's own hand-written model types (it does not get them from us).
interface RateLimitWindowModel {
  update(id: string, data: Record<string, unknown>, opts?: unknown): Promise<{ count: number }>;
  makePrimaryId(a: string, b: number): string;
}
interface AppModels {
  RateLimitWindow: RateLimitWindowModel;
}
interface AdminModels {
  App: { find(id: string): Promise<{ exists(): boolean }> };
}
interface Env {
  DYNAMODB_TABLE: string;
  GLOBAL_ADMIN_APP_ID: string;
  DB_PERF_CACHE_ENABLED?: string;
  DATA_BINDING_SECRET: string;
  DATA: { fetch(request: Request): Promise<Response> };
}
declare function getAppModels(env: Env): AppModels;
declare function getAdminModels(env: Env): AdminModels;

// The resolver: typed input and output, no cast.
export const resolve: ContextResolver<Env, AppModels, AdminModels> = (call, env) => ({
  models: getAppModels(env),
  adminModels: call.scope !== "app" ? getAdminModels(env) : undefined,
  adminPartition: call.actor.adminPartition ?? env.GLOBAL_ADMIN_APP_ID,
  config: { DB_PERF_CACHE_ENABLED: env.DB_PERF_CACHE_ENABLED ?? "false", LIMIT: 1200 },
});

// An async resolver is fine too.
export const asyncResolve: ContextResolver<Env, AppModels> = async (_call, env) => ({
  models: getAppModels(env),
});

// @ts-expect-error a binding is not config
export const leaksBinding: ContextResolver<Env, AppModels> = (_call, env) => ({ models: getAppModels(env), config: { DATA: env.DATA } });

// @ts-expect-error models is required
export const noModels: ContextResolver<Env, AppModels> = () => ({ adminPartition: "x" });

// The actor contract.
export const systemActor = (appId: string): Actor => ({
  kind: "system",
  appId,
  systemAuthority: true,
  preAuthenticated: false,
});
export const userActor: Actor = { kind: "user", userId: "u1", appId: "a", systemAuthority: false, preAuthenticated: true, adminPartition: "adm" };
// @ts-expect-error appId is required
export const noApp: Actor = { kind: "user", systemAuthority: false, preAuthenticated: false };
// @ts-expect-error kind is a closed set
export const badKind: Actor = { kind: "robot", appId: "a", systemAuthority: false, preAuthenticated: false };

// A procedure written against ProcedureContext.
interface ReserveArgs {
  limitKey: string;
  windowStart: number;
}
interface ReserveResult {
  allowed: boolean;
  resetAt: number; // epoch ms, never a Date
}
export const reserve = defineProcedure({
  name: "rateLimit.reserve",
  version: 1,
  scope: "app",
  replay: "conditional",
  args: { type: "object", required: ["limitKey", "windowStart"] },
  async run(ctx: ProcedureContext<AppModels>, { limitKey, windowStart }: ReserveArgs): Promise<ReserveResult> {
    const id = ctx.models.RateLimitWindow.makePrimaryId(limitKey, windowStart);
    const row = await ctx.fresh(() => ctx.models.RateLimitWindow.update(id, { count: "+1" }));
    ctx.logger.info("reserved", { id, count: row.count });
    ctx.logger.warn("plain message");
    ctx.waitUntil(Promise.resolve());
    const tenant: string = ctx.tenant;
    const flag = ctx.config.DB_PERF_CACHE_ENABLED;
    void tenant;
    void flag;
    void ctx.operationId;
    void ctx.requestId;
    const authority: boolean = ctx.actor.systemAuthority;
    void authority;
    return { allowed: row.count < 1200, resetAt: ctx.now() + 60_000 };
  },
});

export const recordActivity = defineProcedure({
  name: "app.recordActivity",
  version: 1,
  scope: "admin",
  replay: "idempotent",
  async run(ctx: ProcedureContext<AppModels, AdminModels>, { appId }: { appId: string }) {
    const app = await ctx.adminModels!.App.find(appId);
    return { exists: app.exists() };
  },
});

// @ts-expect-error replay classes are a closed set
defineProcedure({ name: "x", version: 1, scope: "app", replay: "read-only", async run() { return 1; } });
// @ts-expect-error scope is required
defineProcedure({ name: "x", version: 1, replay: "idempotent", async run() { return 1; } });

const replay: ReplayClass = REPLAY_CLASSES[0];
const scope: Scope = SCOPES[2];
void replay;
void scope;

export const procedures = new ProcedureRegistry([reserve, recordActivity]);
export const manifest: ManifestEntry[] = procedures.manifest();

// The mount.
export const executor = createExecutor<Env>({
  procedures,
  context: resolve,
  ingress: (request, env) => request.headers.get("x-data-binding") === env.DATA_BINDING_SECRET,
  budget: { maxCalls: 8, maxResponseBytes: 1_000_000 },
  region: "aws:us-west-2",
  plainReturns: true,
});
export function handle(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
  return executor.fetch(request, env, ctx);
}

// The caller: outcomes narrow on their tag and ok is typed from the descriptor.
export async function caller(env: Env): Promise<number> {
  const data = remote(env.DATA, { actor: systemActor("app_1"), headers: { "x-data-binding": env.DATA_BINDING_SECRET } });
  const r: Outcome<ReserveResult> = await data.call(reserve, { limitKey: "k", windowStart: 0 }, { tenant: "app_1" });
  if ("ok" in r) {
    const reset: number = r.ok.resetAt;
    const units: number = r.capacity.read + r.capacity.write;
    return reset + units;
  }
  if ("unknown" in r) {
    const why: string = r.reason;
    return why.length;
  }
  const name: string = r.error.name;
  const refused: boolean | undefined = r.error.refused;
  void refused;
  // @ts-expect-error args are typed from the descriptor
  await data.call(reserve, { limitKey: 5 }, { tenant: "app_1" });
  const many = await data.batch([{ procedure: reserve, args: { limitKey: "k", windowStart: 1 }, tenant: "app_1" }]);
  void many;
  return name.length;
}

// Tests use inProcess with the same executor.
export const local: Transport = inProcess(executor, { env: {} as Env, headers: { "x-data-binding": "s" } });

// Codec and context helpers.
const row: EncodedRow = { $model: "User", data: { name: "x" } };
export const encoded = encodeValue({ row });
export const decoded: Record<string, unknown> = decodeRow({ name: "User", fields: {} }, row);
export const e: Error = new CodecError("x");
export const later: Promise<number> = fresh(async () => 1);
export const ctx: ProcedureContext<AppModels> = createContext({
  tenant: "app_1",
  actor: systemActor("app_1"),
  models: {} as AppModels,
  now: () => 0,
});
