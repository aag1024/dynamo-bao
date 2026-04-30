const { QueryError } = require("./exceptions");

const CURSOR_VERSION = 1;

function toBase64Url(str) {
  return Buffer.from(str, "utf8").toString("base64url");
}

function fromBase64Url(str) {
  return Buffer.from(str, "base64url").toString("utf8");
}

/**
 * Encode iteration filter state into an opaque cursor string.
 * @param {Object} state
 * @param {string} state.modelPrefix
 * @param {string|null} state.tenantId
 * @param {number} state.iterationBuckets
 * @param {Array<[number, Object]>} state.queue Ordered list of [bucketNum, exclusiveStartKey]; preserves FIFO scheduling.
 * @returns {string} base64url-encoded cursor
 */
function encodeCursor(state) {
  const payload = {
    v: CURSOR_VERSION,
    m: state.modelPrefix,
    t: state.tenantId ?? null,
    n: state.iterationBuckets,
    b: state.queue,
  };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decode and validate a cursor against the current model and tenant.
 *
 * Cursors are intended to be treated as opaque strings produced by this
 * library and round-tripped by callers — not arbitrary user-supplied input.
 * Callers should not size-bound or otherwise sanitize external strings before
 * passing them here; if cursors flow through an untrusted boundary (e.g. a
 * public API parameter), the caller is responsible for any input-size limits.
 * @param {string} cursor base64url-encoded cursor produced by encodeCursor
 * @param {Object} ctx
 * @param {string} ctx.modelPrefix
 * @param {string|null} ctx.tenantId
 * @param {number} ctx.iterationBuckets
 * @returns {{queue: Array<[number, Object]>}}
 */
function decodeCursor(cursor, ctx) {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new QueryError("Invalid iteration cursor: must be a non-empty string");
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(cursor));
  } catch (err) {
    throw new QueryError(`Invalid iteration cursor: ${err.message}`);
  }

  if (!payload || typeof payload !== "object") {
    throw new QueryError("Invalid iteration cursor: payload is not an object");
  }
  if (payload.v !== CURSOR_VERSION) {
    throw new QueryError(
      `Invalid iteration cursor: unsupported version ${payload.v} (expected ${CURSOR_VERSION})`,
    );
  }
  if (payload.m !== ctx.modelPrefix) {
    throw new QueryError(
      `Invalid iteration cursor: model mismatch (cursor=${payload.m}, expected=${ctx.modelPrefix})`,
    );
  }
  const expectedTenant = ctx.tenantId ?? null;
  if ((payload.t ?? null) !== expectedTenant) {
    throw new QueryError(
      "Invalid iteration cursor: tenant mismatch",
    );
  }
  if (payload.n !== ctx.iterationBuckets) {
    throw new QueryError(
      `Invalid iteration cursor: bucket count changed (cursor=${payload.n}, expected=${ctx.iterationBuckets})`,
    );
  }
  if (!Array.isArray(payload.b)) {
    throw new QueryError("Invalid iteration cursor: queue must be an array");
  }
  for (const entry of payload.b) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !Number.isInteger(entry[0]) ||
      entry[0] < 0 ||
      entry[0] >= ctx.iterationBuckets ||
      !(entry[1] === null || (typeof entry[1] === "object" && !Array.isArray(entry[1])))
    ) {
      throw new QueryError("Invalid iteration cursor: malformed queue entry");
    }
  }

  return { queue: payload.b };
}

module.exports = {
  encodeCursor,
  decodeCursor,
  CURSOR_VERSION,
};
