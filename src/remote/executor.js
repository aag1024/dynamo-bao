/**
 * The executor: a fetch handler that runs envelopes of procedure calls next
 * to DynamoDB.
 *
 * Request:  { v: 1, operationId, requestId?, actor?, calls: [{ id, proc, tenant, args?, actor?, scope? }] }
 * Response: { v: 1, placement: { colo, region }, calls: { [id]: outcome } }
 * Outcome:  { ok: value, capacity, ms } | { error: { name, message, ... }, capacity, ms }
 *
 * Envelope-level failures (ingress, malformed envelope, budget) answer with
 * a non-200 status and `{ v: 1, error: { name, message } }`; no call ran.
 * @module remote/executor
 */
const { ulid } = require("ulid");
const { ProcedureRegistry } = require("./procedures");
const { createContext, runInCall, WAIT_UNTIL_CAP_MS } = require("./context");
const { encodeValue } = require("./codec");
const { isPlainObject } = require("./json");

const PROTOCOL_VERSION = 1;
const DEFAULT_BUDGET = Object.freeze({
  maxCalls: 8,
  maxRequestBytes: 1_000_000,
  maxResponseBytes: 1_000_000,
});
const TENANT = /^[^\]#]+$/;

class EnvelopeError extends Error {
  constructor(name, message, status) {
    super(message);
    this.name = name;
    this.status = status;
  }
}

/** An executor refusal: the procedure did not start, so a resend is safe. */
function refusal(name, message) {
  const e = new Error(message);
  e.name = name;
  e.refused = true;
  return e;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function envelopeFailure(error) {
  return json(error.status, {
    v: PROTOCOL_VERSION,
    error: { name: error.name, message: error.message },
  });
}

/**
 * The error part of an outcome. Names, messages and string or number codes
 * cross; stacks do not. AWS errors (they carry `$metadata`) are marked
 * `infrastructure` with their HTTP status.
 * @private
 */
function encodeError(error) {
  if (!(error instanceof Error)) {
    return { name: "Error", message: typeof error === "string" ? error : String(error) };
  }
  const out = { name: error.name || "Error", message: error.message || "" };
  if (typeof error.code === "string" || typeof error.code === "number") {
    out.code = error.code;
  }
  if (error.$metadata && typeof error.$metadata === "object") {
    out.infrastructure = true;
    if (typeof error.$metadata.httpStatusCode === "number") {
      out.httpStatusCode = error.$metadata.httpStatusCode;
    }
  }
  if (error.refused === true) out.refused = true;
  return out;
}

function validateEnvelope(envelope, budget) {
  if (!isPlainObject(envelope)) {
    throw new EnvelopeError("EnvelopeError", "the envelope must be a JSON object", 400);
  }
  if (envelope.v !== PROTOCOL_VERSION) {
    throw new EnvelopeError(
      "UnsupportedVersion",
      `protocol version ${JSON.stringify(envelope.v)} is not supported; this executor speaks v${PROTOCOL_VERSION}`,
      400,
    );
  }
  const { calls, operationId, requestId, actor } = envelope;
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new EnvelopeError("EnvelopeError", "calls must be a non-empty array", 400);
  }
  if (calls.length > budget.maxCalls) {
    throw new EnvelopeError(
      "BudgetExceeded",
      `the envelope has ${calls.length} calls; the budget allows ${budget.maxCalls}`,
      413,
    );
  }
  if (typeof operationId !== "string" || operationId === "") {
    throw new EnvelopeError("EnvelopeError", "operationId must be a non-empty string", 400);
  }
  if (requestId !== undefined && (typeof requestId !== "string" || requestId === "")) {
    throw new EnvelopeError("EnvelopeError", "requestId must be a non-empty string", 400);
  }
  if (actor !== undefined && !isPlainObject(actor)) {
    throw new EnvelopeError("EnvelopeError", "actor must be an object", 400);
  }
  const ids = new Set();
  calls.forEach((call, i) => {
    const at = `calls[${i}]`;
    const bad = (field, what) =>
      new EnvelopeError("EnvelopeError", `${at}.${field} ${what}`, 400);
    if (!isPlainObject(call)) {
      throw new EnvelopeError("EnvelopeError", `${at} must be an object`, 400);
    }
    if (typeof call.id !== "string" || call.id === "") throw bad("id", "must be a non-empty string");
    if (ids.has(call.id)) {
      throw new EnvelopeError("EnvelopeError", `duplicate call id ${JSON.stringify(call.id)}`, 400);
    }
    ids.add(call.id);
    if (typeof call.proc !== "string" || call.proc === "") {
      throw bad("proc", "must be a procedure id, name@version");
    }
    if (typeof call.tenant !== "string" || !TENANT.test(call.tenant)) {
      throw bad("tenant", 'must be a non-empty string without "]" or "#"');
    }
    if (call.actor !== undefined && !isPlainObject(call.actor)) {
      throw bad("actor", "must be an object");
    }
    if (call.actor === undefined && actor === undefined) {
      throw bad("actor", "is missing and the envelope has no actor");
    }
    if (call.scope !== undefined && typeof call.scope !== "string") {
      throw bad("scope", "must be a string");
    }
  });
}

/**
 * Create the executor.
 * @param {Object} options
 * @param {ProcedureRegistry} options.procedures - What this deployment serves.
 * @param {Function} options.context - The application's context resolver:
 *   `(call, env) => ({ models, adminModels?, adminPartition?, config? })`,
 *   sync or async, called once per call inside the call's tenant and batch
 *   context.
 * @param {(request: Request, env: any) => boolean|Promise<boolean>} options.ingress -
 *   Decides whether a request may use the executor at all (for example by
 *   checking a binding secret header). Required: there is no open default.
 * @param {Object} [options.budget] - `{ maxCalls, maxRequestBytes, maxResponseBytes }`;
 *   defaults 8, 1 MB, 1 MB.
 * @param {string} [options.region] - Echoed as `placement.region`.
 * @param {Object} [options.logger] - Base logger for `ctx.logger`.
 * @param {() => number} [options.now] - Clock for `ctx.now()`.
 * @param {boolean} [options.plainReturns=false] - When true, a model instance
 *   in a result is an error: procedures must return plain views or
 *   explicitly encoded rows. Turn it on in tests.
 * @param {number} [options.waitUntilCapMs=30000]
 * @returns {{ fetch(request: Request, env?: any, ctx?: { waitUntil(p: Promise<any>): void }): Promise<Response>, drain(): Promise<void>, procedures: ProcedureRegistry, budget: Object }}
 */
function createExecutor(options = {}) {
  const {
    procedures,
    context: resolve,
    ingress,
    budget: budgetOption = {},
    region = null,
    logger = console,
    now = Date.now,
    plainReturns = false,
    waitUntilCapMs = WAIT_UNTIL_CAP_MS,
  } = options;
  if (!(procedures instanceof ProcedureRegistry)) {
    throw new TypeError("createExecutor: procedures must be a ProcedureRegistry");
  }
  if (typeof resolve !== "function") {
    throw new TypeError("createExecutor: context must be a context resolver function");
  }
  if (typeof ingress !== "function") {
    throw new TypeError(
      "createExecutor: ingress must be a function; pass () => true only if nothing public can reach the route",
    );
  }
  const budget = Object.freeze({ ...DEFAULT_BUDGET, ...budgetOption });
  const pending = new Set();

  async function runCall(call, envelope, requestId, env, sink) {
    const started = Date.now();
    const descriptor = procedures.get(call.proc);
    const actor = call.actor ?? envelope.actor;
    const settled = await runInCall(call.tenant, async () => {
      if (!descriptor) {
        const name = typeof call.proc === "string" ? call.proc.split("@")[0] : "";
        const served = procedures.versions(name);
        throw refusal(
          "UnknownProcedure",
          `no procedure ${call.proc}` +
            (served.length ? `; versions of ${name} served: ${served.join(", ")}` : ""),
        );
      }
      if (call.scope !== undefined && call.scope !== descriptor.scope) {
        throw refusal(
          "ScopeError",
          `${descriptor.id} is scope "${descriptor.scope}", the call says "${call.scope}"`,
        );
      }
      if (actor.appId !== call.tenant) {
        throw refusal(
          "ActorTenantMismatch",
          `the actor's appId does not match the call tenant for ${descriptor.id}`,
        );
      }
      let ctx;
      try {
        const resolved = await resolve(
          {
            id: call.id,
            proc: descriptor.id,
            name: descriptor.name,
            version: descriptor.version,
            tenant: call.tenant,
            scope: descriptor.scope,
            replay: descriptor.replay,
            actor,
            requestId,
            operationId: envelope.operationId,
          },
          env,
        );
        if (!resolved || typeof resolved !== "object" || !resolved.models) {
          throw new TypeError(`the context resolver returned no models for ${descriptor.id}`);
        }
        if (descriptor.scope !== "app" && !resolved.adminModels) {
          throw refusal(
            "ScopeError",
            `${descriptor.id} is scope "${descriptor.scope}" but the context resolver returned no adminModels`,
          );
        }
        ctx = createContext({
          tenant: call.tenant,
          actor,
          models: resolved.models,
          scope: descriptor.scope,
          adminModels: resolved.adminModels,
          adminPartition: resolved.adminPartition,
          config: resolved.config ?? {},
          requestId,
          operationId: envelope.operationId,
          logger,
          now,
          waitUntil: sink,
          waitUntilCapMs,
        });
      } catch (error) {
        if (error && typeof error === "object") error.refused = true;
        throw error;
      }
      const result = await descriptor.run(ctx, call.args === undefined ? null : call.args);
      return encodeValue(result, { models: plainReturns ? "refuse" : "encode" });
    });
    const ms = Date.now() - started;
    return "error" in settled
      ? { error: encodeError(settled.error), capacity: settled.capacity, ms }
      : { ok: settled.value, capacity: settled.capacity, ms };
  }

  function fitResponse(body) {
    let text = JSON.stringify(body);
    if (text.length <= budget.maxResponseBytes) return text;
    const sizes = Object.entries(body.calls)
      .map(([id, outcome]) => [id, JSON.stringify(outcome).length])
      .sort((a, b) => b[1] - a[1]);
    for (const [id, bytes] of sizes) {
      const { capacity, ms } = body.calls[id];
      body.calls[id] = {
        error: {
          name: "ResponseTooLarge",
          message: `the result was ${bytes} bytes; the response budget is ${budget.maxResponseBytes}`,
          executed: true,
        },
        capacity,
        ms,
      };
      text = JSON.stringify(body);
      if (text.length <= budget.maxResponseBytes) break;
    }
    return text;
  }

  async function fetch(request, env, platform) {
    let allowed = false;
    try {
      allowed = (await ingress(request, env)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return envelopeFailure(
        new EnvelopeError("IngressRefused", "this route only accepts calls from the data binding", 403),
      );
    }
    if (request.method !== "POST") {
      return envelopeFailure(new EnvelopeError("EnvelopeError", "use POST", 405));
    }
    let envelope;
    try {
      let text;
      try {
        text = await request.text();
      } catch {
        throw new EnvelopeError("EnvelopeError", "the request body could not be read", 400);
      }
      if (text.length > budget.maxRequestBytes) {
        throw new EnvelopeError(
          "BudgetExceeded",
          `the request is ${text.length} bytes; the budget allows ${budget.maxRequestBytes}`,
          413,
        );
      }
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new EnvelopeError("EnvelopeError", "the body is not JSON", 400);
      }
      validateEnvelope(envelope, budget);
    } catch (error) {
      return envelopeFailure(error);
    }

    const requestId = envelope.requestId ?? ulid();
    const sink = (promise) => {
      pending.add(promise);
      promise.finally(() => pending.delete(promise));
      if (platform && typeof platform.waitUntil === "function") platform.waitUntil(promise);
    };
    const outcomes = await Promise.all(
      envelope.calls.map((call) => runCall(call, envelope, requestId, env, sink)),
    );
    const body = {
      v: PROTOCOL_VERSION,
      placement: { colo: request.cf?.colo ?? null, region },
      calls: {},
    };
    envelope.calls.forEach((call, i) => {
      body.calls[call.id] = outcomes[i];
    });
    return new Response(fitResponse(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return Object.freeze({
    fetch,
    /** Resolve once every deferred piece of work handed to ctx.waitUntil has settled. */
    async drain() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    procedures,
    budget,
  });
}

module.exports = { createExecutor, PROTOCOL_VERSION, DEFAULT_BUDGET };
