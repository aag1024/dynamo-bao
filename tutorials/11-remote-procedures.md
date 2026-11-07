# Remote Procedures

`dynamo-bao/remote` lets code that runs far from DynamoDB make one
cross-region trip per logical operation. You register named, versioned
procedures on a Worker placed next to the table (the data worker). Callers
anywhere else, such as Durable Objects near their users or Workflows, send
the procedure's name, version and JSON arguments, and get a tagged outcome
back. Nothing executable crosses the wire.

```text
caller (near the user) ──one fetch──▶ data worker (next to DynamoDB) ──▶ DynamoDB
                                       registry lookup, tenant, batch context,
                                       N DynamoDB calls at the local latency
```

A complete Worker is in `examples/cloudflare-remote-executor/`. The design and
its measurements are in `design-docs/remote-procedure-executor.md`.

## The frozen contract

The shapes in this section are frozen. Procedures, context resolvers and
callers are written against them, and consumers cite this section in their
own specifications. A change to any of them is a breaking change to
`dynamo-bao/remote` and is announced as such; it is never made silently.
`src/remote/index.d.ts` ships these types, and a test in this repository
fails if this section and the declarations disagree.

### ProcedureContext

What a procedure's `run(ctx, args)` receives.

```ts
interface ProcedureContext {
  models: AppModels;            // the call tenant's models, batching on
  adminModels?: AdminModels;    // only for scope "admin" | "both", for the resolver's admin partition
  tenant: string;               // read-only; also a value, since rows store appId
  actor: Actor;                 // the envelope's actor; the only ambient authority inside the executor
  requestId: string;
  operationId: string;          // the envelope's replay unit; key a needs-ledger marker by it
  logger: Logger;               // debug/info/warn/error(message, detail?), bound to requestId and tenant
  now(): number;                // the call's clock, epoch milliseconds
  fresh<T>(fn: () => Promise<T>): Promise<T>;   // nested batch context for re-read after a lost conditional write
  waitUntil(p: Promise<unknown>): void;         // deferred work next to DynamoDB, 30 s cap, really awaited
  config: ReadonlyEnvConfig;    // flags and settings, deep-frozen, no bindings
}
```

The context is frozen. `ctx.models` is whatever the context resolver
returned. The executor has already entered the call's tenant and opened a
batch context, so finds in one tick coalesce into one `BatchGetItem` and the
loader cache dedupes repeated reads.

`operationId` is the one field added to the shape the consumer first wrote
down (issue #18). A `needs-ledger` procedure needs it to key its marker.

### Actor

Who is calling, as the caller determined it.

```ts
interface Actor {
  kind: "user" | "system" | "admin";
  userId?: string;              // attribution; ids a procedure acts on are args
  appId: string;                // must equal the call's tenant or the executor refuses
  systemAuthority: boolean;     // what the caller's own authority check answered for appId
  preAuthenticated: boolean;    // "a person started this"
  adminPartition?: string;      // the admin partition the caller resolved, for scope "admin"
}
```

The library reads only `appId`, to check that it equals the call's tenant.
`kind`, `userId`, `systemAuthority`, `preAuthenticated` and `adminPartition`
pass through to `ctx.actor` and to the context resolver untouched; the
executor never branches on them. Code moved behind a procedure reads
`ctx.actor`, never a module global.

### Outcomes

Every call settles to exactly one of three tagged outcomes.

| Tag | Shape | Meaning |
|---|---|---|
| `ok` | `{ ok: value, capacity, ms }` | The procedure returned `value`. |
| `error` | `{ error: { name, message, ... }, capacity?, ms? }` | The procedure threw, or the call was refused. |
| `unknown` | `{ unknown: true, reason }` | The caller's transport failed after sending. Only the client produces this; the executor never does. |

Test the tag with `in`: `"ok" in r`, `"unknown" in r`, otherwise `r.error`.
The error object carries:

| Field | When |
|---|---|
| `name`, `message` | Always. Application errors keep their names (`ConditionalError`, `ItemNotFoundError`, `ValidationError`, your own). Stacks never cross. |
| `code` | When the thrown error had a string or number `code`. |
| `refused: true` | The procedure did not start: unknown procedure, scope mismatch, actor/tenant mismatch, context resolver failure, ingress refusal, malformed envelope, budget. Resending is safe. |
| `infrastructure: true`, `httpStatusCode` | An AWS error (throttling, service errors). |
| `executed: true` | `ResponseTooLarge`: the procedure ran, but its result exceeded the response budget and was dropped. |

### Replay classes

Every procedure declares what a resend after `unknown` does. The registry
refuses a procedure without one.

| Class | Meaning | The client resends it automatically? |
|---|---|---|
| `idempotent` | No writes, or writes whose repeat has no further effect. | Yes, if you set `retries`. |
| `conditional` | Every write is a guarded state transition (`create` that fails if the row exists, update guarded on the previous value, conditional delete). A second attempt fails its condition and the procedure reports that. | Yes, if you set `retries`. |
| `needs-ledger` | An unguarded write or a counter. The procedure must persist its own marker keyed by `ctx.operationId`. | Never. The caller gets `unknown` and decides. |

A resend reuses the envelope's `operationId`.

## Defining procedures

```js
const { defineProcedure, ProcedureRegistry, encodeValue } = require("dynamo-bao/remote");
const { exceptions: { ConditionalError } } = require("dynamo-bao");

const createNote = defineProcedure({
  name: "note.create",
  version: 1,
  scope: "app",              // "app" | "admin" | "both"
  replay: "conditional",
  args: { type: "object", required: ["noteId", "text"] }, // JSON, published by manifest()
  async run(ctx, { noteId, text }) {
    try {
      const note = await ctx.models.Note.create({ noteId, text });
      return { created: true, note: encodeValue(note) };
    } catch (e) {
      if (!(e instanceof ConditionalError)) throw e;
      const existing = await ctx.fresh(() => ctx.models.Note.find(noteId));
      return { created: false, note: encodeValue(existing) };
    }
  },
});

const procedures = new ProcedureRegistry([createNote /* , ... */]);
```

`defineProcedure` checks the name (letters, digits, `.`, `_`, `-`; no `@`),
the version (a positive integer), the scope, the replay class and that
`args` is JSON, and refuses unknown keys so a typo can't go unnoticed. The
descriptor it returns is frozen and is addressed as `name@version`.

### Versions and the previous-version obligation

Bump the version when the arguments or the result shape change. After a
split into two bundles, long-lived Durable Objects and replayed Workflows
can call a newer data worker than the one they were built against, so the
data worker must keep serving the previous version for one deploy of the
callers.

That is the application's obligation, not the library's. The registry
serves `note.create@1` beside `note.create@2` only while both descriptors
are passed to it. Keep the previous descriptor registered for one caller
deploy, then drop it. The registry refuses a version gap (`@1` and `@3`
without `@2`), so a dropped middle version can't go unnoticed.

`registry.manifest()` lists every registered procedure as plain JSON
(`id`, `name`, `version`, `scope`, `replay`, `args`), sorted, for a build
step that publishes argument schemas from the data bundle to the callers'
bundle.

## The context resolver and the mount

The library does not know how your application builds its models or what
its admin partition is. You tell it with a context resolver, and you mount
the executor on one route.

```js
const { createExecutor } = require("dynamo-bao/remote");

const executor = createExecutor({
  procedures,
  context: (call, env) => ({
    models: getAppModels(env),
    adminModels: call.scope !== "app" ? getAdminModels(env) : undefined,
    adminPartition: call.actor.adminPartition ?? env.GLOBAL_ADMIN_APP_ID,
    config: { DB_PERF_CACHE_ENABLED: env.DB_PERF_CACHE_ENABLED ?? "false" },
  }),
  ingress: (request, env) => request.headers.get("x-data-binding") === env.DATA_BINDING_SECRET,
  budget: { maxCalls: 8, maxRequestBytes: 1_000_000, maxResponseBytes: 1_000_000 },
  region: "aws:us-west-2",
});

// In the Worker's fetch handler:
if (url.pathname === "/_data/call") return executor.fetch(request, env, ctx);
```

The resolver runs once per call, inside the call's tenant and batch
context, and receives `{ id, proc, name, version, tenant, scope, replay,
actor, requestId, operationId }` and your `env`. It returns:

| Field | |
|---|---|
| `models` | Required. Becomes `ctx.models`. |
| `adminModels` | Required for scope `admin` and `both`; dropped for `app`. |
| `adminPartition` | The tenant `adminModels` are bound to. Every operation on them, including `save()` on rows they return and related loads, runs in that tenant while `ctx.models` stays in the call tenant. Omit it if your admin models need no tenant. |
| `config` | Plain JSON settings; deep-copied and frozen into `ctx.config`. A binding or any other non-JSON value is refused. |

The `ContextResolver` type checks a resolver without a cast:

```ts
import type { ContextResolver } from "dynamo-bao/remote";
export const resolve: ContextResolver<Env, AppModels, AdminModels> = (call, env) => ({ ... });
```

`ingress` is required. In a single-bundle layout the route is reachable from
the internet, so check a binding secret; in a two-bundle layout the data
worker has no public route, and `() => true` is acceptable. A refused
request gets `403` before its body is read.

`budget` bounds one envelope: more than `maxCalls` calls or a body over
`maxRequestBytes` is refused with `413`. A response over `maxResponseBytes`
has its largest results replaced by `ResponseTooLarge` errors (marked
`executed: true`) until it fits.

`placement` in every response echoes the colo the request ran in
(`request.cf.colo`) and the `region` you configured, so callers can verify
placement.

Deployment settings (`wrangler.toml`, placement, binding names, the secret)
belong to the application. The example shows one way to do it.

## Calling procedures

```js
const { remote } = require("dynamo-bao/remote");
const { createNote } = require("./procedures");   // descriptors only

const data = remote(env.DATA, {
  actor: { kind: "system", appId, systemAuthority: true, preAuthenticated: false },
  headers: { "x-data-binding": env.DATA_BINDING_SECRET },
  retries: 1,
});

const r = await data.call(createNote, { noteId, text }, { tenant: appId });
if ("ok" in r) {
  const note = Note.fromRemote(r.ok.note);
} else if ("unknown" in r) {
  // decide by the procedure's replay class
} else {
  // r.error.name, r.error.refused, ...
}
```

- `remote(transport, options)` takes a service binding or anything with
  `fetch(request)`. Options: a default `actor`, `retries` (default 0),
  `headers`, `url`.
- `call(descriptor, args, { tenant, actor?, operationId?, requestId? })`
  posts one envelope. `actor` overrides the default for that call.
- `batch([{ id?, procedure, args, tenant, actor? }, ...])` sends several
  calls in one envelope and resolves to outcomes by id. The calls run
  concurrently on the executor, each with its own tenant, batch context and
  capacity, and a throw in one does not affect another. They share one
  invocation's CPU, memory and response.
- The capacity each call reports is added to the caller's batch-context
  accumulator, so `getBatchContextCapacity()` on the caller includes remote
  work.
- Arguments go through the codec: model instances become `{ $model, data }`,
  and a `Date` or other non-JSON value throws `CodecError` before anything
  is sent.

## Values on the wire

Everything that crosses is plain JSON. Procedures return plain views shaped
for their caller: dates as epoch milliseconds, rows as `encodeValue(row)`.

`encodeValue(value)` encodes a model row as `{ $model: "<Model>", data }`
holding only its declared fields:

| Field type | On the wire |
|---|---|
| `DateTimeField`, `CreateDateField`, `ModifiedDateField` | epoch milliseconds |
| `TtlField` | epoch milliseconds (stored in seconds) |
| `BinaryField` | `{ "$binary": "<base64>" }` |
| `StringSetField` | array of strings |
| `StringField`, `UlidField`, `RelatedField` (the id), `IntegerField`, `FloatField`, `CounterField`, `VersionField`, `BooleanField` | the stored value |
| a custom field | its stored value if that is JSON; otherwise the row is refused with a `CodecError` naming the model and field |

`ObjectNotFound` encodes as `null`. A `Date`, `Map`, `Set`, `Buffer`, class
instance, function, `undefined` in an array, `NaN`, `Infinity`, bigint,
symbol-keyed object or cycle anywhere in a value throws `CodecError` with
the path of the first one (`$.rows[2].resetAt: a Date is not JSON; send
epoch milliseconds`). A `Date` in a result is always an error, because
`JSON.stringify` would turn it into a string silently and a caller that
calls `.getTime()` on it would break.

By default the executor also encodes model instances found in a result.
With `createExecutor({ plainReturns: true })` a model instance in a result
is an error instead, so every row has to be encoded deliberately. Turn it on
in tests.

### Detached instances

`Model.fromRemote(row)` hydrates a read-only instance from an encoded row.
Getters work as on a loaded instance (dates come back as `Date`, sets as
`Set`), and `isDetached()` is true. `save`, `update`, `delete`,
`loadRelatedData` and `getOrLoadRelatedField` throw `DetachedInstanceError`,
whose message points at the procedure API: a write belongs in a procedure.
Static model methods are not guarded; the real boundary is that the caller's
bundle holds no DynamoDB credentials.

`decodeRow(Model, row)` returns the stored representation `fromRemote`
builds on. Fields the receiving model does not declare are dropped, so a row
from a newer bundle still hydrates.

## fresh and waitUntil

`ctx.fresh(fn)` runs `fn` in a nested batch context with its own loader
cache, so its reads go to DynamoDB. When it settles, its capacity is added
to the call's total, and rows it read or wrote replace the outer cache's
entries (rows it deleted are evicted), so a later `find` in the call sees
them. Use it to re-read after a lost conditional write. `fresh` is also
exported for use outside procedures.

`ctx.waitUntil(promise)` keeps deferred work running next to DynamoDB after
the response is sent. The executor hands it to the platform's
`ExecutionContext.waitUntil`, caps each piece at 30 s, and logs failures
through `ctx.logger` instead of throwing. Without a platform context (in
Node tests), `await executor.drain()` waits for it.

## Testing

Procedure tests are plain function tests with `createContext`:

```js
const { createContext } = require("dynamo-bao/remote");
const ctx = createContext({ tenant: appId, actor, models: { Note }, now: () => 1_700_000_000_000 });
await runWithBatchContext(() =>
  TenantContext.runWithTenant(appId, () => createNote.run(ctx, { noteId, text })),
);
```

Caller tests use `inProcess(executor, { env, headers, ctx })`, a transport
that runs the executor in the same isolate with no network. The request
still goes through ingress, so pass the headers it expects. The procedure
runs in its own tenant and batch context, not the caller's. `inProcess` runs
under workerd as well as Node; `examples/cloudflare-remote-executor/test/`
runs it with `@cloudflare/vitest-pool-workers`.

## Worked example: subscribing to a document

The WebSocket subscribe path in a document server checks a user's access to
a document and records the connection. Run from a Durable Object near the
user, that is several sequential DynamoDB round trips across a region. As a
procedure it is one trip, and two rounds inside the data worker's region.

```js
const subscribeToDocument = defineProcedure({
  name: "document.subscribe",
  version: 1,
  scope: "app",
  replay: "conditional",   // the mapping create is guarded
  async run(ctx, { userId, documentId, connectionId, ttlMs }) {
    const { Document, DocumentPermission, AppMembership, DocumentGroupPermission, ConnectionMapping } = ctx.models;
    // One tick: the two finds coalesce into one BatchGetItem; the queries run beside it.
    const [doc, direct, memberships, groups] = await Promise.all([
      Document.find(documentId),
      DocumentPermission.find({ documentId, userId }),
      AppMembership.queryByIndex("membershipsForApp", ctx.tenant, { membershipKey: { $beginsWith: `${userId}#` } }),
      DocumentGroupPermission.queryByIndex("groupPermissionsForDocument", documentId),
    ]);
    const level = selectLevel({ doc, direct, memberships, groups, systemAuthority: ctx.actor.systemAuthority });
    if (!level) return { level: null };
    try {
      await ConnectionMapping.create({ connectionId, userId, documentId, appId: ctx.tenant, ttl: ctx.now() + ttlMs });
    } catch (e) {
      if (!(e instanceof ConditionalError)) throw e;   // already mapped: fine on a resend
    }
    return { level, routing: { shard: doc.shard } };   // a plain view, only what the caller uses
  },
});
```

The caller, in the Durable Object:

```js
const r = await data.call(subscribeToDocument, { userId, documentId, connectionId, ttlMs: 300_000 }, { tenant: appId });
if ("unknown" in r) return retryLater();          // conditional: safe to resend
if ("error" in r) return closeWithError(r.error.name);
if (!r.ok.level) return refuse();
accept(r.ok.level, r.ok.routing);                 // fan-out and socket replies stay here
```

Things to notice:

- Everything that touches DynamoDB for the operation is in one procedure.
  If a caller makes two calls where the second depends on the first, they
  are one procedure.
- `selectLevel` is pure and reads authority from `ctx.actor`, not from a
  module global that the data worker would not have.
- The result is a plain view. The `Document` row does not cross; the
  routing fields the caller needs do.
- The replay class is `conditional` because the only write is a guarded
  create. A counter would make it `needs-ledger`.
- Socket replies, fan-out to peers and Durable Object storage stay on the
  caller. `ctx` has no Durable Object stubs or bindings by design.
