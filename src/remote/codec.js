/**
 * Wire codec for procedure arguments and results.
 *
 * Everything that crosses the executor boundary is plain JSON. Model rows
 * travel as `{ $model: "<ModelName>", data: { <field>: <value> } }` holding
 * only the model's declared fields, with:
 * - DateTimeField, CreateDateField, ModifiedDateField, TtlField: epoch
 *   milliseconds (TtlField is stored in seconds and converted).
 * - BinaryField: `{ $binary: "<base64>" }`.
 * - StringSetField: an array of strings.
 * - Every other built-in field: its stored value, which is already JSON.
 * - A custom field: its stored value if that is plain JSON; otherwise the
 *   row is refused with a CodecError naming the model and field.
 *
 * Any other non-JSON value (Date, Map, Set, Buffer, class instance, function,
 * NaN, ...) is refused rather than letting JSON.stringify change it silently.
 * @module remote/codec
 */
const fields = require("../fields");
const { findNonJson, isPlainObject } = require("./json");
const { ObjectNotFound } = require("../object-not-found");

class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodecError";
  }
}

const DATE_FIELDS = [
  fields.DateTimeFieldClass, // CreateDate, ModifiedDate and Ttl extend it
];

function isDateField(field) {
  return DATE_FIELDS.some((C) => field instanceof C);
}

function isModelInstance(value) {
  // Lazy: model.js requires this module for fromRemote.
  const { BaoModel } = require("../model");
  return value instanceof BaoModel;
}

function isBinary(value) {
  return value instanceof Uint8Array; // Buffer is a Uint8Array
}

function toBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text) {
  if (typeof Buffer !== "undefined") return Buffer.from(text, "base64");
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function encodeField(modelName, fieldName, field, dy) {
  if (dy === undefined) return undefined;
  if (dy === null) return null;
  const where = `${modelName}.${fieldName}`;
  if (field instanceof fields.TtlFieldClass) {
    if (typeof dy !== "number") throw new CodecError(`${where}: stored TTL is not a number`);
    return dy * 1000;
  }
  if (isDateField(field)) {
    if (typeof dy !== "number") throw new CodecError(`${where}: stored date is not a number`);
    return dy;
  }
  if (field instanceof fields.BinaryFieldClass) {
    if (!isBinary(dy)) throw new CodecError(`${where}: stored binary is not bytes`);
    return { $binary: toBase64(dy) };
  }
  if (field instanceof fields.StringSetFieldClass) {
    const list = dy instanceof Set ? [...dy] : dy;
    if (!Array.isArray(list) || list.some((s) => typeof s !== "string")) {
      throw new CodecError(`${where}: stored string set is not an array of strings`);
    }
    return [...list];
  }
  const bad = findNonJson(dy);
  if (bad) {
    throw new CodecError(
      `${where}: the stored value is not JSON (found ${bad.found}); the remote codec can't ship this field`,
    );
  }
  return dy;
}

function decodeField(modelName, fieldName, field, wire) {
  if (wire === undefined) return undefined;
  if (wire === null) return null;
  const where = `${modelName}.${fieldName}`;
  if (field instanceof fields.TtlFieldClass) {
    if (typeof wire !== "number" || !Number.isFinite(wire)) {
      throw new CodecError(`${where}: expected epoch milliseconds`);
    }
    return Math.floor(wire / 1000);
  }
  if (isDateField(field)) {
    if (typeof wire !== "number" || !Number.isFinite(wire)) {
      throw new CodecError(`${where}: expected epoch milliseconds`);
    }
    return wire;
  }
  if (field instanceof fields.BinaryFieldClass) {
    if (!isPlainObject(wire) || typeof wire.$binary !== "string") {
      throw new CodecError(`${where}: expected { $binary: "<base64>" }`);
    }
    return fromBase64(wire.$binary);
  }
  if (field instanceof fields.StringSetFieldClass) {
    if (!Array.isArray(wire) || wire.some((s) => typeof s !== "string")) {
      throw new CodecError(`${where}: expected an array of strings`);
    }
    return [...wire];
  }
  const bad = findNonJson(wire);
  if (bad) throw new CodecError(`${where}: expected JSON, found ${bad.found}`);
  return wire;
}

/**
 * Encode one model instance as `{ $model, data }`.
 * @private
 */
function encodeRow(instance) {
  const Model = instance.constructor;
  const data = {};
  for (const [fieldName, field] of Object.entries(Model.fields)) {
    const value = encodeField(Model.name, fieldName, field, instance._dyData[fieldName]);
    if (value !== undefined) data[fieldName] = value;
  }
  return { $model: Model.name, data };
}

/**
 * Encode a procedure argument or result as plain JSON.
 * @param {any} value
 * @param {Object} [options]
 * @param {"encode"|"refuse"} [options.models="encode"] - What to do with a
 *   model instance found in `value`: encode it as `{ $model, data }`, or
 *   refuse it (the plain-view rule: a procedure must encode rows itself,
 *   with `encodeValue(row)`, so none crosses by accident).
 * @returns {any} A plain-JSON copy. An `ObjectNotFound` becomes null; a
 *   top-level undefined becomes null.
 * @throws {CodecError} Naming the path of the first value that is not JSON.
 */
function encodeValue(value, { models = "encode" } = {}) {
  return encodeAt(value, "$", models, new Set());
}

function encodeAt(value, path, models, seen) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") {
    const bad = findNonJson(value, path);
    if (bad) throw nonJson(bad);
    return value;
  }
  if (value instanceof ObjectNotFound) return null;
  if (isModelInstance(value)) {
    if (models === "refuse") {
      throw new CodecError(
        `${path}: a ${value.constructor.name} instance crossed the boundary; return encodeValue(row) or a plain view`,
      );
    }
    return encodeRow(value);
  }
  if (seen.has(value)) throw new CodecError(`${path}: a circular reference is not JSON`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        if (!(i in value) || value[i] === undefined) {
          throw nonJson({ path: `${path}[${i}]`, found: "undefined" });
        }
        out[i] = encodeAt(value[i], `${path}[${i}]`, models, seen);
      }
      return out;
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw nonJson(findNonJson(value, path));
    }
    const out = {};
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      out[key] = encodeAt(value[key], `${path}.${key}`, models, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function nonJson({ path, found }) {
  const hint = found === "a Date" ? "; send epoch milliseconds" : "";
  return new CodecError(`${path}: ${found} is not JSON${hint}`);
}

/**
 * Decode an encoded row into the model's stored representation (the shape
 * of `instance._dyData`: dates as epoch ms, TTL in seconds, binary as bytes,
 * string sets as arrays). `Model.fromRemote` builds on this.
 * Fields the receiving model does not declare are dropped, so a row from a
 * newer bundle still hydrates.
 * @param {typeof import("../model").BaoModel} ModelClass
 * @param {{ $model: string, data: Object }} encoded
 * @returns {Object}
 * @throws {CodecError}
 */
function decodeRow(ModelClass, encoded) {
  if (!isPlainObject(encoded) || typeof encoded.$model !== "string") {
    throw new CodecError(`decodeRow: expected { $model, data } for ${ModelClass.name}`);
  }
  if (encoded.$model !== ModelClass.name) {
    throw new CodecError(
      `decodeRow: the row is a ${encoded.$model}, not a ${ModelClass.name}`,
    );
  }
  if (!isPlainObject(encoded.data)) {
    throw new CodecError(`decodeRow: ${ModelClass.name} row has no data object`);
  }
  const dy = {};
  for (const [fieldName, field] of Object.entries(ModelClass.fields)) {
    const value = decodeField(ModelClass.name, fieldName, field, encoded.data[fieldName]);
    if (value !== undefined) dy[fieldName] = value;
  }
  return dy;
}

module.exports = { encodeValue, decodeRow, CodecError };
