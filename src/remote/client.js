/**
 * The caller side: post envelopes to an executor and get tagged outcomes.
 * @module remote/client
 */
const { ulid } = require("ulid");
const { encodeValue } = require("./codec");
const { isPlainObject } = require("./json");
const { REPLAY_CLASSES, SCOPES } = require("./procedures");
const { _accumulateCapacityToContext } = require("../mixins/batch-loading-mixin");

const DEFAULT_URL = "https://dynamo-bao.executor/_data/call";

function assertDescriptor(procedure) {
  if (
    !procedure ||
    typeof procedure.id !== "string" ||
    !REPLAY_CLASSES.includes(procedure.replay) ||
    !SCOPES.includes(procedure.scope)
  ) {
    throw new TypeError(
      "remote: the first argument must be a procedure descriptor from defineProcedure",
    );
  }
}

function addCapacity(capacity) {
  if (!capacity) return;
  if (typeof capacity.read === "number") _accumulateCapacityToContext(capacity.read, "read");
  if (typeof capacity.write === "number") _accumulateCapacityToContext(capacity.write, "write");
}

/**
 * Wrap a transport as a client.
 * @param {{fetch: function(Request): Promise<Response>}} transport - A
 *   service binding (`env.DATA`), `inProcess(executor)`, or anything with a
 *   compatible `fetch`.
 * @param {Object} [options]
 * @param {Object} [options.actor] - Default actor for every call.
 * @param {number} [options.retries=0] - Resends after a transport failure,
 *   for envelopes whose calls are all `idempotent` or `conditional`. A
 *   `needs-ledger` call is never resent; its caller gets `unknown`.
 * @param {string} [options.url] - Request URL; only the path matters to a
 *   service binding. Defaults to a URL ending in `/_data/call`.
 * @param {Object<string,string>} [options.headers] - Extra request headers,
 *   e.g. the binding secret the executor's ingress check expects.
 */
function remote(transport, options = {}) {
  if (!transport || typeof transport.fetch !== "function") {
    throw new TypeError("remote: the transport must have a fetch(request) method");
  }
  const { actor: defaultActor, retries = 0, url = DEFAULT_URL, headers = {} } = options;

  async function send(entries, { operationId = ulid(), requestId } = {}) {
    const calls = entries.map((e) => {
      const call = {
        id: e.id,
        proc: e.procedure.id,
        tenant: e.tenant,
        scope: e.procedure.scope,
        args: encodeValue(e.args === undefined ? null : e.args),
      };
      if (e.actor !== undefined) call.actor = e.actor;
      return call;
    });
    const envelope = { v: 1, operationId };
    if (requestId !== undefined) envelope.requestId = requestId;
    if (defaultActor !== undefined) envelope.actor = defaultActor;
    envelope.calls = calls;
    const body = JSON.stringify(envelope);
    const resendable = entries.every((e) => e.procedure.replay !== "needs-ledger");

    const unknownAll = (reason) =>
      Object.fromEntries(entries.map((e) => [e.id, { unknown: true, reason }]));

    let attempt = 0;
    for (;;) {
      const result = await attemptOnce(body);
      if (result.transportFailure && resendable && attempt < retries) {
        attempt += 1;
        continue;
      }
      if (result.transportFailure) return unknownAll(result.reason);
      if (result.envelopeError) {
        const error = { ...result.envelopeError, refused: true };
        return Object.fromEntries(entries.map((e) => [e.id, { error }]));
      }
      // fromEntries defines own properties, so an id such as "__proto__" keeps its outcome
      return Object.fromEntries(
        entries.map((e) => {
          const outcome = Object.hasOwn(result.calls, e.id) ? result.calls[e.id] : undefined;
          if (!outcome || !("ok" in outcome || "error" in outcome)) {
            return [e.id, { unknown: true, reason: "the response has no outcome for this call" }];
          }
          addCapacity(outcome.capacity);
          return [e.id, outcome];
        }),
      );
    }
  }

  async function attemptOnce(body) {
    let response;
    try {
      response = await transport.fetch(
        new Request(url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body,
        }),
      );
    } catch (error) {
      return { transportFailure: true, reason: `transport failed: ${error?.message || error}` };
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      return {
        transportFailure: true,
        reason: `HTTP ${response.status} without an executor envelope`,
      };
    }
    if (!isPlainObject(parsed) || parsed.v !== 1) {
      return { transportFailure: true, reason: `HTTP ${response.status} without an executor envelope` };
    }
    if (response.status !== 200) {
      if (isPlainObject(parsed.error) && typeof parsed.error.name === "string") {
        return { envelopeError: parsed.error };
      }
      return { transportFailure: true, reason: `HTTP ${response.status}` };
    }
    if (!isPlainObject(parsed.calls)) {
      return { transportFailure: true, reason: "the response has no calls" };
    }
    return { calls: parsed.calls, placement: parsed.placement };
  }

  function prepare(entry, i) {
    assertDescriptor(entry.procedure);
    if (typeof entry.tenant !== "string" || entry.tenant === "") {
      throw new TypeError(`remote: call ${entry.procedure.id} needs a tenant`);
    }
    if (entry.actor === undefined && defaultActor === undefined) {
      throw new TypeError(`remote: call ${entry.procedure.id} needs an actor (per call or on remote())`);
    }
    return { ...entry, id: entry.id ?? `c${i}` };
  }

  return Object.freeze({
    /**
     * Call one procedure.
     * @param {Object} procedure - A descriptor from defineProcedure.
     * @param {any} args - JSON arguments; model instances are encoded.
     * @param {{tenant: string, actor: (Object|undefined), operationId: (string|undefined), requestId: (string|undefined)}} options
     * @returns {Promise<Object>} One outcome: `{ok, capacity, ms}`,
     *   `{error, capacity?, ms?}` or `{unknown: true, reason}`.
     */
    async call(procedure, args, { tenant, actor, operationId, requestId } = {}) {
      const entry = prepare({ id: "c0", procedure, args, tenant, actor }, 0);
      const out = await send([entry], { operationId, requestId });
      return out.c0;
    },

    /**
     * Call several procedures in one envelope. They run concurrently and in
     * isolation on the executor.
     * @param {Array<Object>} calls - Each `{id?, procedure, args?, tenant, actor?}`.
     * @param {{operationId: (string|undefined), requestId: (string|undefined)}} [options]
     * @returns {Promise<Object<string, Object>>} Outcomes by call id.
     */
    async batch(calls, options) {
      if (!Array.isArray(calls) || calls.length === 0) {
        throw new TypeError("remote: batch needs a non-empty array of calls");
      }
      const entries = calls.map(prepare);
      const ids = new Set();
      for (const e of entries) {
        if (ids.has(e.id)) throw new TypeError(`remote: duplicate call id "${e.id}"`);
        ids.add(e.id);
      }
      return send(entries, options);
    },
  });
}

/**
 * A transport that runs the executor in this isolate with no network: for
 * tests and `wrangler dev`. The request still goes through the executor's
 * ingress check, so pass the headers it expects.
 * @param {{fetch: Function}} executor - From createExecutor.
 * @param {Object} [options]
 * @param {any} [options.env] - Passed to the executor as `env`.
 * @param {Object<string,string>} [options.headers] - Added to every request.
 * @param {{waitUntil: function(Promise<*>)}} [options.ctx] - Passed as the
 *   execution context; without it deferred work is awaited by executor.drain().
 */
function inProcess(executor, { env, headers = {}, ctx } = {}) {
  if (!executor || typeof executor.fetch !== "function" || typeof executor.drain !== "function") {
    throw new TypeError("inProcess needs an executor from createExecutor");
  }
  return Object.freeze({
    async fetch(request) {
      const extra = Object.entries(headers);
      let req = request;
      if (extra.length > 0) {
        const merged = new Headers(request.headers);
        for (const [k, v] of extra) merged.set(k, v);
        req = new Request(request, { headers: merged });
      }
      return executor.fetch(req, env, ctx);
    },
  });
}

module.exports = { remote, inProcess };
