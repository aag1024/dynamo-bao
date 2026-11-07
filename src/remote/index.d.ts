// Type declarations for dynamo-bao/remote.
//
// These are the contract the application compiles against. ProcedureContext,
// Actor, the outcome tags (ok / error / unknown) and the replay classes
// (idempotent / conditional / needs-ledger) are frozen: see
// tutorials/11-remote-procedures.md. A change to any of them is a breaking
// change to this entry point.

/** Plain JSON: what crosses the executor boundary. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** What a resend after an `unknown` outcome does. */
export type ReplayClass = "idempotent" | "conditional" | "needs-ledger";

/** Which model sets a procedure receives. */
export type Scope = "app" | "admin" | "both";

export const REPLAY_CLASSES: readonly ["idempotent", "conditional", "needs-ledger"];
export const SCOPES: readonly ["app", "admin", "both"];

/**
 * Who is calling. The executor reads only `appId` (it must equal the call's
 * tenant, or the call is refused); every other field passes through to the
 * procedure untouched and uninterpreted.
 */
export interface Actor {
  kind: "user" | "system" | "admin";
  /** Attribution. Ids a procedure acts on are arguments, not this. */
  userId?: string;
  /** Must equal the call's tenant. */
  appId: string;
  /** What the caller's own authority check answered for appId. */
  systemAuthority: boolean;
  /** "A person started this." */
  preAuthenticated: boolean;
  /** The admin partition the caller resolved, for scope "admin" | "both". */
  adminPartition?: string;
}

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/** Flags and settings, deep-frozen. Never bindings. */
export type ReadonlyEnvConfig = { readonly [key: string]: DeepReadonly<JsonValue> };
type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Read and write capacity units a call consumed. */
export interface Capacity {
  read: number;
  write: number;
}

/** What a procedure's `run` receives. */
export interface ProcedureContext<Models = any, AdminModels = any> {
  /** The call tenant's models, batching on. */
  readonly models: Models;
  /** Only for scope "admin" | "both", bound to the resolver's admin partition. */
  readonly adminModels?: AdminModels;
  /** The call tenant, read-only; also a value, since rows store appId. */
  readonly tenant: string;
  /** The envelope's actor: the only ambient authority inside the executor. */
  readonly actor: Readonly<Actor>;
  readonly requestId: string;
  /** The envelope's replay unit; key a needs-ledger marker by it. */
  readonly operationId: string;
  /** Bound to requestId and tenant. */
  readonly logger: Logger;
  /** The call's clock (epoch ms). */
  now(): number;
  /** Nested batch context for a re-read after a lost conditional write. */
  fresh<T>(fn: () => Promise<T>): Promise<T>;
  /** Deferred work next to DynamoDB, 30 s cap, awaited past the response. */
  waitUntil(promise: Promise<unknown>): void;
  readonly config: ReadonlyEnvConfig;
}

/** What the executor passes to the application's context resolver. */
export interface ResolverCall {
  /** The call's id within its envelope. */
  id: string;
  /** "name@version". */
  proc: string;
  name: string;
  version: number;
  tenant: string;
  scope: Scope;
  replay: ReplayClass;
  actor: Actor;
  requestId: string;
  operationId: string;
}

/** What the application's context resolver returns. */
export interface ResolvedContext<Models = any, AdminModels = any> {
  models: Models;
  /** Required for scope "admin" | "both"; dropped for scope "app". */
  adminModels?: AdminModels;
  /** Tenant adminModels are bound to. Omit if they need no tenant. */
  adminPartition?: string;
  config?: { [key: string]: JsonValue };
}

/**
 * The application's hook: build the models and settings for one call. Runs
 * inside the call's tenant and batch context, once per call.
 */
export type ContextResolver<Env = unknown, Models = any, AdminModels = any> = (
  call: ResolverCall,
  env: Env,
) => ResolvedContext<Models, AdminModels> | Promise<ResolvedContext<Models, AdminModels>>;

/** A registered procedure; also what a caller passes to `call`. */
export interface ProcedureDescriptor<Args = any, Result = any> {
  /** "name@version". */
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly scope: Scope;
  readonly replay: ReplayClass;
  readonly args: JsonValue | null;
  readonly run: (ctx: ProcedureContext, args: Args) => Promise<Result>;
}

export interface ProcedureSpec<Args, Result, Models, AdminModels> {
  name: string;
  version: number;
  scope: Scope;
  replay: ReplayClass;
  /** JSON description of the arguments, published by manifest(). */
  args?: JsonValue;
  run(ctx: ProcedureContext<Models, AdminModels>, args: Args): Promise<Result>;
}

export function defineProcedure<Args = any, Result = any, Models = any, AdminModels = any>(
  spec: ProcedureSpec<Args, Result, Models, AdminModels>,
): ProcedureDescriptor<Args, Result>;

export interface ManifestEntry {
  id: string;
  name: string;
  version: number;
  scope: Scope;
  replay: ReplayClass;
  args: JsonValue | null;
}

export class ProcedureRegistry {
  constructor(descriptors: ProcedureDescriptor<any, any>[]);
  get(id: string): ProcedureDescriptor | undefined;
  has(id: string): boolean;
  versions(name: string): number[];
  latest(name: string): ProcedureDescriptor | undefined;
  manifest(): ManifestEntry[];
}

/** The error part of an outcome. */
export interface RemoteError {
  name: string;
  message: string;
  code?: string | number;
  /** The procedure did not start (executor refusal or resolver failure). */
  refused?: true;
  /** An AWS error, with its HTTP status. */
  infrastructure?: true;
  httpStatusCode?: number;
  /** ResponseTooLarge: the procedure ran, its result was dropped. */
  executed?: true;
}

export interface OkOutcome<T> {
  ok: T;
  capacity: Capacity;
  ms: number;
}
export interface ErrorOutcome {
  error: RemoteError;
  capacity?: Capacity;
  ms?: number;
}
/** The caller's transport failed after sending. Only the client produces this. */
export interface UnknownOutcome {
  unknown: true;
  reason: string;
}
export type Outcome<T> = OkOutcome<T> | ErrorOutcome | UnknownOutcome;

/** A model row on the wire; hydrate it with `Model.fromRemote(row)`. */
export interface EncodedRow {
  $model: string;
  data: { [field: string]: JsonValue };
}

export class CodecError extends Error {}
export class DetachedInstanceError extends Error {
  modelName: string;
  method: string;
}

/**
 * Encode a value as plain JSON: model instances become EncodedRow (or are
 * refused with `models: "refuse"`); Date, Map, Set, Buffer and other
 * non-JSON values throw CodecError naming their path.
 */
export function encodeValue(value: unknown, options?: { models?: "encode" | "refuse" }): JsonValue;

/** Decode an EncodedRow to the model's stored representation. */
export function decodeRow(
  ModelClass: { name: string; fields: Record<string, unknown> },
  encoded: EncodedRow,
): Record<string, unknown>;

export interface CreateContextOptions<Models, AdminModels> {
  tenant: string;
  actor: Actor;
  models: Models;
  scope?: Scope;
  adminModels?: AdminModels;
  adminPartition?: string;
  requestId?: string;
  operationId?: string;
  config?: { [key: string]: JsonValue };
  logger?: Partial<Logger>;
  now?: () => number;
  waitUntil?: (promise: Promise<void>) => void;
  waitUntilCapMs?: number;
}

/** Build a ProcedureContext; procedure unit tests call it directly. */
export function createContext<Models = any, AdminModels = any>(
  options: CreateContextOptions<Models, AdminModels>,
): ProcedureContext<Models, AdminModels>;

/** Run fn in a nested batch context; merge its capacity and cache back. */
export function fresh<T>(fn: () => Promise<T>): Promise<T>;

/** Model classes that always operate in tenantId. */
export function bindModelsToTenant<M extends Record<string, unknown>>(models: M, tenantId: string): M;

export interface Budget {
  maxCalls?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ExecutorOptions<Env> {
  procedures: ProcedureRegistry;
  context: ContextResolver<Env>;
  /** Decide whether a request may use the executor at all. */
  ingress(request: Request, env: Env): boolean | Promise<boolean>;
  budget?: Budget;
  /** Echoed as placement.region. */
  region?: string;
  logger?: Partial<Logger>;
  now?: () => number;
  /** A model instance in a result is an error. Turn on in tests. */
  plainReturns?: boolean;
  waitUntilCapMs?: number;
}

export interface Executor<Env = unknown> {
  fetch(request: Request, env?: Env, ctx?: WaitUntilContext): Promise<Response>;
  /** Resolve once all deferred work has settled. */
  drain(): Promise<void>;
  readonly procedures: ProcedureRegistry;
  readonly budget: Readonly<Required<Budget>>;
}

export function createExecutor<Env = unknown>(options: ExecutorOptions<Env>): Executor<Env>;

/** A service binding, inProcess(executor), or anything with this fetch. */
export interface Transport {
  fetch(request: Request): Promise<Response>;
}

export interface RemoteOptions {
  actor?: Actor;
  /** Resends after a transport failure; never for needs-ledger. Default 0. */
  retries?: number;
  url?: string;
  headers?: Record<string, string>;
}

export interface CallOptions {
  tenant: string;
  actor?: Actor;
  operationId?: string;
  requestId?: string;
}

export interface BatchCall<Args = any> {
  id?: string;
  procedure: ProcedureDescriptor<Args, any>;
  args?: Args;
  tenant: string;
  actor?: Actor;
}

export interface RemoteClient {
  call<Args, Result>(
    procedure: ProcedureDescriptor<Args, Result>,
    args: Args,
    options: CallOptions,
  ): Promise<Outcome<Result>>;
  batch(
    calls: BatchCall[],
    options?: { operationId?: string; requestId?: string },
  ): Promise<Record<string, Outcome<unknown>>>;
}

export function remote(transport: Transport, options?: RemoteOptions): RemoteClient;

export function inProcess<Env>(
  executor: Executor<Env>,
  options?: { env?: Env; headers?: Record<string, string>; ctx?: WaitUntilContext },
): Transport;
