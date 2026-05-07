// Pure helpers for searchable models. Kept dependency-free so they can be
// unit-tested in isolation and reused for both write-side index population
// and read-side query normalization.

const NON_ALPHANUM_REGEX = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE_REGEX = /\s+/g;

function normalize(text, { caseSensitive = false } = {}) {
  let result = String(text).replace(NON_ALPHANUM_REGEX, " ");
  if (!caseSensitive) result = result.toLowerCase();
  result = result.replace(WHITESPACE_REGEX, " ").trim();
  return result;
}

function buildSearchText(values, config) {
  const {
    fields = [],
    caseSensitive = false,
    minTermLength = 1,
    dedupe = false,
  } = config || {};

  const parts = [];
  for (const fieldName of fields) {
    const value = values[fieldName];
    if (value === null || value === undefined) continue;
    parts.push(String(value));
  }
  if (parts.length === 0) return "";

  let text = normalize(parts.join(" "), { caseSensitive });
  if (text === "") return "";

  const needsTokenize = dedupe || (minTermLength && minTermLength > 1);
  if (!needsTokenize) return text;

  const tokens = text.split(" ");
  const filtered = [];
  const seen = new Set();
  for (const tok of tokens) {
    if (!tok) continue;
    if (minTermLength > 1 && [...tok].length < minTermLength) continue;
    if (dedupe) {
      if (seen.has(tok)) continue;
      seen.add(tok);
    }
    filtered.push(tok);
  }
  return filtered.join(" ");
}

function normalizeSearchTerm(term, config = {}) {
  return normalize(term, config);
}

function tokenizeSearchQuery(query) {
  if (typeof query !== "string") return [];
  const tokens = [];
  let i = 0;
  const n = query.length;
  while (i < n) {
    const ch = query[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const close = query.indexOf('"', i + 1);
      if (close === -1) {
        const phrase = query.slice(i + 1).trim();
        if (phrase) tokens.push(phrase);
        break;
      }
      const phrase = query.slice(i + 1, close).trim();
      if (phrase) tokens.push(phrase);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(query[j]) && query[j] !== '"') j++;
    const word = query.slice(i, j);
    if (word) tokens.push(word);
    i = j;
  }
  return tokens;
}

// Decide what `_searchText` should be on a save.
//
// Returns:
//   undefined → do not include `_searchText` in the update payload (leave the
//               row's existing value untouched, or skip on insert).
//   null      → include `_searchText: null` (caller emits REMOVE).
//   string    → include `_searchText: <value>` (caller emits SET).
//
// Inputs:
//   searchConfig: the validated `static searchConfig` object, or null.
//   dyUpdatesToSave: the diff being written to DynamoDB (in Dy format —
//                    string fields stay as strings, so this is the same
//                    representation that buildSearchText reads).
//   currentItem: the loaded model instance whose `_dyData` holds current
//                values. Required for non-isNew updates so untouched source
//                fields can be backfilled. May be null for insert.
//   isNew: true on create.
//   forceReindex: true when the caller wants every index attribute
//                 recomputed from the merged state regardless of which
//                 fields were touched.
function computeSearchTextUpdate({
  searchConfig,
  dyUpdatesToSave,
  currentItem,
  isNew = false,
  forceReindex = false,
}) {
  if (!searchConfig) return undefined;

  const fields = searchConfig.fields || [];
  const sourceTouched = fields.some((f) =>
    Object.prototype.hasOwnProperty.call(dyUpdatesToSave, f),
  );

  if (!isNew && !forceReindex && !sourceTouched) return undefined;

  const merged = {};
  if (currentItem && currentItem._dyData) {
    for (const f of fields) {
      if (f in currentItem._dyData) merged[f] = currentItem._dyData[f];
    }
  }
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(dyUpdatesToSave, f)) {
      merged[f] = dyUpdatesToSave[f];
    }
  }

  const result = buildSearchText(merged, searchConfig);

  if (result === "") {
    return isNew ? undefined : null;
  }
  return result;
}

// Build a DynamoDB FilterExpression predicate that matches rows whose
// `_searchText` contains the supplied terms. Terms are normalized with the
// same rules used to build `_searchText` so the values match what's stored.
//
// Returns null-safe `{ FilterExpression, ExpressionAttributeNames,
// ExpressionAttributeValues }`. The caller is responsible for AND'ing this
// into any user-supplied filter.
const VALID_OPERATORS = new Set(["$and", "$or"]);

function buildSearchPredicate(terms, searchConfig, options = {}) {
  if (!Array.isArray(terms)) {
    throw new Error("terms must be an array of strings.");
  }
  for (const t of terms) {
    if (typeof t !== "string") {
      throw new Error("terms must be strings.");
    }
  }
  const { operator = "$and" } = options;
  if (!VALID_OPERATORS.has(operator)) {
    throw new Error(
      `operator must be one of: ${Array.from(VALID_OPERATORS).join(", ")}.`,
    );
  }

  // Mirror the write-side filter: terms shorter than minTermLength are
  // dropped from the predicate so the user can't silently get zero matches
  // by querying for a term the index doesn't store. Length is counted in
  // Unicode code points to match buildSearchText's [...tok].length check.
  const minTermLength =
    (searchConfig && searchConfig.minTermLength) || 1;
  const normalized = [];
  for (const t of terms) {
    const n = normalizeSearchTerm(t, searchConfig || {});
    if (n && [...n].length >= minTermLength) normalized.push(n);
  }
  if (normalized.length === 0) {
    throw new Error("searchAll requires at least one non-empty term.");
  }

  // `:stN` placeholders are deliberately a separate namespace from the
  // FilterExpressionBuilder convention (`:vN`, see src/filter-expression.js)
  // so the two can be merged into a single FilterExpression without colliding.
  const join = operator === "$or" ? " OR " : " AND ";
  const parts = [];
  const values = {};
  normalized.forEach((value, idx) => {
    const key = `:st${idx}`;
    parts.push(`contains(#st, ${key})`);
    values[key] = value;
  });

  const expression =
    parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(join);

  return {
    FilterExpression: expression,
    ExpressionAttributeNames: { "#st": "_searchText" },
    ExpressionAttributeValues: values,
  };
}

// Validate a `limit` option value. Accepts positive integers and Infinity.
// Anything else throws — saves the caller from passing 0 or a float and
// silently getting weird behavior downstream.
function validateLimit(limit) {
  if (limit === Infinity) return;
  if (
    typeof limit !== "number" ||
    Number.isNaN(limit) ||
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    throw new Error("limit must be a positive integer or Infinity.");
  }
}

// Take an async iterable of arrays (batches) and re-yield them, capping the
// total flattened item count at `limit`. The last batch yielded is sliced to
// fit so the consumer never sees more than `limit` items in total. Stops
// pulling from the source once the cap is hit, so a generator-backed source
// is suspended (no further DynamoDB Query calls, no further bucket scans).
async function* applyLimit(asyncIterable, limit) {
  if (limit === Infinity) {
    yield* asyncIterable;
    return;
  }
  let yielded = 0;
  for await (const batch of asyncIterable) {
    const room = limit - yielded;
    if (room <= 0) return;
    if (batch.length === 0) {
      yield batch;
      continue;
    }
    if (batch.length <= room) {
      yield batch;
      yielded += batch.length;
      if (yielded >= limit) return;
    } else {
      yield batch.slice(0, room);
      return;
    }
  }
}

// Stable, deterministic hash of a search predicate. Used to invalidate a
// cursor if the caller resumes with different terms / operator / config —
// otherwise a continuation key from the old query would silently splice
// rows from a different result set into the new one. Not cryptographic;
// just a reliable equality check.
function predicateHash(terms, operator, searchConfig) {
  const cfg = searchConfig || {};
  const normalized = (terms || []).map((t) =>
    normalizeSearchTerm(String(t), cfg),
  );
  const payload = JSON.stringify({
    terms: normalized,
    operator: operator || "$and",
    caseSensitive: !!cfg.caseSensitive,
    minTermLength: cfg.minTermLength || 1,
    dedupe: !!cfg.dedupe,
  });
  // Simple FNV-1a 32-bit. Collisions are astronomically rare for our
  // input space and we don't need cryptographic strength.
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const CURSOR_REQUIRED_FIELDS = ["bucketCursors", "predicateHash", "modelPrefix"];

function encodeCursor(state) {
  if (!state || typeof state !== "object") {
    throw new Error("encodeCursor: invalid state.");
  }
  for (const f of CURSOR_REQUIRED_FIELDS) {
    if (!(f in state)) {
      throw new Error(`encodeCursor: missing required field "${f}".`);
    }
  }
  const json = JSON.stringify({
    bucketCursors: state.bucketCursors,
    predicateHash: state.predicateHash,
    modelPrefix: state.modelPrefix,
    pendingItemKeys: state.pendingItemKeys || [],
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeCursor(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("Invalid cursor: must be a non-empty string.");
  }
  let json;
  try {
    json = Buffer.from(encoded, "base64url").toString("utf8");
  } catch (e) {
    throw new Error("Invalid cursor: not valid base64url.");
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error("Invalid cursor: payload is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid cursor: payload is not an object.");
  }
  for (const f of CURSOR_REQUIRED_FIELDS) {
    if (!(f in parsed)) {
      throw new Error(`Invalid cursor: missing required field "${f}".`);
    }
  }
  return parsed;
}

module.exports = {
  buildSearchText,
  normalizeSearchTerm,
  tokenizeSearchQuery,
  computeSearchTextUpdate,
  buildSearchPredicate,
  applyLimit,
  validateLimit,
  predicateHash,
  encodeCursor,
  decodeCursor,
};
