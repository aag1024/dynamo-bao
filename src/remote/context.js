/**
 * The context a procedure runs with, and the call scope the executor enters
 * for it.
 * @module remote/context
 */
const { TenantContext } = require("../tenant-context");
const { ModelManager } = require("../model-manager");
const {
  runWithBatchContext,
  getBatchContextStore,
} = require("../mixins/batch-loading-mixin");
const { SCOPES } = require("./procedures");
const { findNonJson, isPlainObject, deepFreeze, jsonClone } = require("./json");

/** Default cap on one piece of deferred work, in milliseconds. */
const WAIT_UNTIL_CAP_MS = 30_000;

const LEVELS = ["debug", "info", "warn", "error"];

/**
 * A loader cache that remembers which keys were deleted, so `fresh` can
 * replay deletions onto the outer cache.
 * @private
 */
class TrackingMap extends Map {
  constructor() {
    super();
    this.deleted = new Set();
  }
  set(key, value) {
    this.deleted.delete(key);
    return super.set(key, value);
  }
  delete(key) {
    this.deleted.add(key);
    return super.delete(key);
  }
}

/**
 * Run `fn` in a nested batch context: its own loader cache (so reads go to
 * DynamoDB, not the outer cache) and its own capacity accumulator. When it
 * settles, its capacity is added to the outer context's total, and rows it
 * read or wrote replace the outer cache's entries (rows it deleted are
 * evicted), so a later `find` in the outer context sees them. This is the
 * "re-read after a lost conditional write" pattern.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function fresh(fn) {
  const outer = getBatchContextStore();
  return runWithBatchContext(async () => {
    const inner = getBatchContextStore();
    const tracking = new TrackingMap();
    if (inner) inner.loaderContext = tracking;
    try {
      return await fn();
    } finally {
      if (outer && inner) {
        if (outer.capacityAccumulator && inner.capacityAccumulator) {
          outer.capacityAccumulator.read += inner.capacityAccumulator.read;
          outer.capacityAccumulator.write += inner.capacityAccumulator.write;
        }
        if (outer.loaderContext) {
          for (const key of tracking.deleted) outer.loaderContext.delete(key);
          for (const [key, value] of tracking) outer.loaderContext.set(key, value);
        }
      }
    }
  });
}

/**
 * Run `fn` as one call: inside `tenant` and a new batch context. Never
 * rejects; settles to `{ value, capacity }` or `{ error, capacity }`, with
 * the capacity the call consumed either way.
 * @param {string} tenant
 * @param {() => Promise<any>} fn
 * @returns {Promise<{value?: any, error?: any, capacity: {read: number, write: number}}>}
 */
function runInCall(tenant, fn) {
  return TenantContext.runWithTenant(tenant, () =>
    runWithBatchContext(async () => {
      const store = getBatchContextStore();
      const capacity = () =>
        store?.capacityAccumulator
          ? { read: store.capacityAccumulator.read, write: store.capacityAccumulator.write }
          : { read: 0, write: 0 };
      try {
        const value = await fn();
        return { value, capacity: capacity() };
      } catch (error) {
        return { error, capacity: capacity() };
      }
    }),
  );
}

const BOUND = new WeakMap(); // base model -> Map(tenant -> bound model)

function boundManager(tenantId) {
  const base = ModelManager.forTenant(tenantId);
  const view = Object.create(base);
  view.getModel = (name) => bindModel(base.getModel(name), tenantId);
  return view;
}

function bindModel(Base, tenantId) {
  let byTenant = BOUND.get(Base);
  if (!byTenant) {
    byTenant = new Map();
    BOUND.set(Base, byTenant);
  }
  let Bound = byTenant.get(tenantId);
  if (!Bound) {
    Bound = class extends Base {
      static get manager() {
        return boundManager(tenantId);
      }
    };
    Object.defineProperty(Bound, "name", { value: Base.name });
    byTenant.set(tenantId, Bound);
  }
  return Bound;
}

/**
 * Return model classes that always operate in `tenantId`, whatever tenant
 * the surrounding code runs in. Statics, instances they return (`save`),
 * related loads and batching all use `tenantId`; the base classes are not
 * changed. This is how `ctx.adminModels` reaches the admin partition from
 * inside an app-tenant call.
 * @param {Object<string, Function>} models - Model classes by name.
 * @param {string} tenantId
 * @returns {Object<string, Function>}
 */
function bindModelsToTenant(models, tenantId) {
  if (!tenantId || typeof tenantId !== "string") {
    throw new TypeError("bindModelsToTenant needs a tenant id");
  }
  ModelManager.forTenant(tenantId); // rejects ids that could forge keys
  const out = {};
  for (const [name, Model] of Object.entries(models)) {
    out[name] = typeof Model === "function" ? bindModel(Model, tenantId) : Model;
  }
  return Object.freeze(out);
}

function bindLogger(base, bound) {
  const logger = {};
  for (const level of LEVELS) {
    const write =
      typeof base?.[level] === "function"
        ? base[level].bind(base)
        : typeof base?.info === "function"
          ? base.info.bind(base)
          : () => {};
    logger[level] = (message, detail) => {
      const extra =
        detail === undefined
          ? {}
          : isPlainObject(detail) || (detail && typeof detail === "object" && !Array.isArray(detail))
            ? detail
            : { detail };
      write(message, { ...bound, ...extra });
    };
  }
  return Object.freeze(logger);
}

function capped(promise, capMs, logger) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      logger.warn(`deferred work exceeded ${capMs} ms and was abandoned`);
      resolve();
    }, capMs);
    if (typeof timer?.unref === "function") timer.unref();
  });
  const work = Promise.resolve(promise).then(
    () => {},
    (error) =>
      logger.error("deferred work failed", {
        error: String((error && (error.stack || error.message)) || error),
      }),
  );
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Build the context a procedure receives.
 *
 * The executor calls this for every call with what the application's
 * context resolver returned; procedure unit tests call it directly.
 * @param {Object} options
 * @param {string} options.tenant - The call tenant; also `ctx.tenant`.
 * @param {Object} options.actor - The call's actor, passed through as is.
 * @param {Object} options.models - The tenant's model classes.
 * @param {"app"|"admin"|"both"} [options.scope="app"] - The procedure's scope.
 * @param {Object} [options.adminModels] - Admin model classes; kept only for
 *   scope "admin" or "both", where they are required.
 * @param {string} [options.adminPartition] - Tenant the admin models are
 *   bound to. Omit when the admin models need no tenant.
 * @param {string} [options.requestId]
 * @param {string} [options.operationId] - The envelope's replay unit.
 * @param {Object} [options.config] - Plain settings; deep-copied and frozen.
 * @param {Object} [options.logger] - Base logger with debug/info/warn/error.
 * @param {() => number} [options.now] - Clock; defaults to Date.now.
 * @param {(p: Promise<void>) => void} [options.waitUntil] - Sink for
 *   deferred work (the platform's ExecutionContext.waitUntil).
 * @param {number} [options.waitUntilCapMs=30000]
 * @returns {Readonly<Object>} The ProcedureContext.
 */
function createContext(options) {
  const {
    tenant,
    actor,
    models,
    scope = "app",
    adminModels,
    adminPartition,
    requestId = "",
    operationId = "",
    config = {},
    logger: baseLogger = console,
    now = Date.now,
    waitUntil: sink = () => {},
    waitUntilCapMs = WAIT_UNTIL_CAP_MS,
  } = options || {};

  if (typeof tenant !== "string" || tenant === "") {
    throw new TypeError("createContext: tenant must be a non-empty string");
  }
  if (!isPlainObject(actor)) {
    throw new TypeError("createContext: actor is required and must be an object");
  }
  const badActor = findNonJson(actor, "actor");
  if (badActor) {
    throw new TypeError(`createContext: ${badActor.path} is ${badActor.found}; the actor must be JSON`);
  }
  if (!models || typeof models !== "object") {
    throw new TypeError("createContext: models is required");
  }
  if (!SCOPES.includes(scope)) {
    throw new TypeError(`createContext: unknown scope ${JSON.stringify(scope)}`);
  }
  const wantsAdmin = scope === "admin" || scope === "both";
  if (wantsAdmin && (!adminModels || typeof adminModels !== "object")) {
    throw new TypeError(
      `createContext: scope "${scope}" needs adminModels from the context resolver`,
    );
  }
  const badConfig = findNonJson(config, "config");
  if (badConfig || !isPlainObject(config)) {
    throw new TypeError(
      `createContext: config must be plain settings, no bindings${badConfig ? ` (${badConfig.path} is ${badConfig.found})` : ""}`,
    );
  }

  const logger = bindLogger(baseLogger, { requestId, tenant });
  const ctx = {
    models,
    tenant,
    actor: deepFreeze(jsonClone(actor)),
    requestId,
    operationId,
    logger,
    now: () => now(),
    fresh,
    waitUntil(promise) {
      if (!promise || typeof promise.then !== "function") {
        throw new TypeError("ctx.waitUntil needs a promise");
      }
      sink(capped(promise, waitUntilCapMs, logger));
    },
    config: deepFreeze(jsonClone(config)),
  };
  if (wantsAdmin) {
    ctx.adminModels = adminPartition
      ? bindModelsToTenant(adminModels, adminPartition)
      : adminModels;
  }
  return Object.freeze(ctx);
}

module.exports = {
  createContext,
  fresh,
  runInCall,
  bindModelsToTenant,
  WAIT_UNTIL_CAP_MS,
};
