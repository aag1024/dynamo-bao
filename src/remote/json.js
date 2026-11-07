/**
 * Plain-JSON checks shared by the remote modules. A value is plain JSON when
 * JSON.stringify followed by JSON.parse returns an equal value: null,
 * booleans, finite numbers, strings, arrays of plain JSON, and objects whose
 * prototype is Object.prototype or null with plain-JSON values. Anything else
 * (Date, Map, Set, Buffer, class instances, functions, undefined inside an
 * array, NaN, Infinity, bigint, symbol, cycles) is not, because
 * JSON.stringify either drops it, throws, or changes its type silently.
 * @module remote/json
 * @private
 */

function describe(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return "a bigint";
  if (typeof value === "symbol") return "a symbol";
  if (typeof value === "function") return "a function";
  const ctor = Object.getPrototypeOf(value)?.constructor?.name;
  return ctor ? `a ${ctor}` : "an object with a custom prototype";
}

/**
 * Return null when `value` is plain JSON, otherwise `{ path, found }`
 * naming the first offending location ("$.a[2].b") and what was there.
 * `allow(value)` may return true to accept a value the caller handles itself.
 */
function findNonJson(value, path = "$", allow = null, seen = new Set()) {
  if (allow && allow(value)) return null;
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : { path, found: describe(value) };
    case "object":
      break;
    default:
      return { path, found: describe(value) };
  }
  if (seen.has(value)) return { path, found: "a circular reference" };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) return { path: `${path}[${i}]`, found: "a hole" };
        const bad = findNonJson(value[i], `${path}[${i}]`, allow, seen);
        if (bad) return bad;
      }
      return null;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return { path, found: describe(value) };
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { path, found: "an object with symbol keys" };
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      // JSON.stringify drops undefined object members; treat that as absent
      // rather than an error, since `{ a: undefined }` round-trips to `{}`.
      if (child === undefined) continue;
      const bad = findNonJson(child, `${path}.${key}`, allow, seen);
      if (bad) return bad;
    }
    return null;
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

module.exports = { findNonJson, isPlainObject, deepFreeze };
