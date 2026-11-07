/**
 * Named, versioned procedures and the registry the executor serves them from.
 * @module remote/procedures
 */
const { findNonJson, deepFreeze, jsonClone } = require("./json");

/**
 * What a resend after an `unknown` outcome does. Frozen vocabulary: see
 * tutorials/11-remote-procedures.md.
 * - `idempotent`: no writes, or writes whose repeat has no further effect.
 * - `conditional`: every write is a guarded state transition, so a repeat
 *   fails its condition and the procedure reports that.
 * - `needs-ledger`: an unguarded write or a counter; the procedure keeps its
 *   own marker keyed by `ctx.operationId`. The client never resends it.
 */
const REPLAY_CLASSES = Object.freeze(["idempotent", "conditional", "needs-ledger"]);

/**
 * Which model sets a procedure receives. `app`: `ctx.models` only. `admin` and
 * `both`: also `ctx.adminModels`, bound to the admin partition the context
 * resolver names.
 */
const SCOPES = Object.freeze(["app", "admin", "both"]);

const NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const ID = /^([A-Za-z][A-Za-z0-9_.-]*)@([1-9][0-9]*)$/;
const DESCRIPTOR_KEYS = new Set(["name", "version", "scope", "replay", "args", "run"]);
const DESCRIPTORS = new WeakSet();

/**
 * Define a procedure. The returned descriptor is what the registry serves and
 * what a caller passes to `remote(...).call`.
 * @param {Object} spec
 * @param {string} spec.name - Dotted name, e.g. "rateLimit.reserve". No "@".
 * @param {number} spec.version - Positive integer. Bump it when args or the
 *   result shape change; keep the previous descriptor registered for one
 *   deploy so callers built against it keep working.
 * @param {"app"|"admin"|"both"} spec.scope
 * @param {"idempotent"|"conditional"|"needs-ledger"} spec.replay
 * @param {Object} [spec.args] - JSON description of the arguments (for
 *   example a JSON Schema). Not interpreted; published by `manifest()`.
 * @param {(ctx: Object, args: any) => Promise<any>} spec.run
 * @returns {Readonly<Object>} The descriptor.
 */
function defineProcedure(spec) {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("defineProcedure needs a descriptor object");
  }
  for (const key of Object.keys(spec)) {
    if (!DESCRIPTOR_KEYS.has(key)) {
      throw new TypeError(
        `defineProcedure: unknown key "${key}"; expected ${[...DESCRIPTOR_KEYS].join(", ")}`,
      );
    }
  }
  const { name, version, scope, replay, args = null, run } = spec;
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new TypeError(
      `defineProcedure: name ${JSON.stringify(name)} must start with a letter and contain only letters, digits, ".", "_" or "-"`,
    );
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError(`defineProcedure ${name}: version must be a positive integer`);
  }
  if (!SCOPES.includes(scope)) {
    throw new TypeError(
      `defineProcedure ${name}@${version}: scope must be one of ${SCOPES.join(", ")}`,
    );
  }
  if (!REPLAY_CLASSES.includes(replay)) {
    throw new TypeError(
      `defineProcedure ${name}@${version}: replay class must be one of ${REPLAY_CLASSES.join(", ")}`,
    );
  }
  if (typeof run !== "function") {
    throw new TypeError(`defineProcedure ${name}@${version}: run must be a function`);
  }
  const bad = args === null ? null : findNonJson(args);
  if (bad || (args !== null && typeof args !== "object")) {
    throw new TypeError(
      `defineProcedure ${name}@${version}: args must be a plain JSON description${bad ? ` (found ${bad.found} at ${bad.path})` : ""}`,
    );
  }
  const descriptor = Object.freeze({
    id: `${name}@${version}`,
    name,
    version,
    scope,
    replay,
    args: args === null ? null : deepFreeze(jsonClone(args)),
    run,
  });
  DESCRIPTORS.add(descriptor);
  return descriptor;
}

function isDescriptor(value) {
  return DESCRIPTORS.has(value);
}

/**
 * The set of procedures one deployment serves.
 *
 * Previous-version serving is the application's obligation: the registry
 * serves `name@1` beside `name@2` only while both descriptors are passed in.
 * Keep the previous version registered for one deploy of the callers, then
 * drop it. Versions of one name must be contiguous; a gap is refused so a
 * dropped middle version can't go unnoticed.
 */
class ProcedureRegistry {
  /** @param {Object[]} descriptors - Results of defineProcedure. */
  constructor(descriptors) {
    if (!Array.isArray(descriptors)) {
      throw new TypeError("ProcedureRegistry needs an array of descriptors");
    }
    const byId = new Map();
    const byName = new Map();
    for (const d of descriptors) {
      if (!isDescriptor(d)) {
        throw new TypeError(
          "ProcedureRegistry: every entry must come from defineProcedure",
        );
      }
      if (byId.has(d.id)) {
        throw new Error(`ProcedureRegistry: ${d.id} is registered twice`);
      }
      byId.set(d.id, d);
      if (!byName.has(d.name)) byName.set(d.name, []);
      byName.get(d.name).push(d.version);
    }
    for (const [name, versions] of byName) {
      versions.sort((a, b) => a - b);
      for (let i = 1; i < versions.length; i++) {
        if (versions[i] !== versions[i - 1] + 1) {
          throw new Error(
            `ProcedureRegistry: version gap for ${name}: has ${versions.join(", ")}, missing ${versions[i - 1] + 1}`,
          );
        }
      }
      Object.freeze(versions);
    }
    this._byId = byId;
    this._byName = byName;
    Object.freeze(this);
  }

  /** @returns {Object|undefined} The descriptor for "name@version". */
  get(id) {
    if (typeof id !== "string" || !ID.test(id)) return undefined;
    return this._byId.get(id);
  }

  has(id) {
    return this.get(id) !== undefined;
  }

  /** @returns {number[]} Registered versions of `name`, ascending. */
  versions(name) {
    return [...(this._byName.get(name) || [])];
  }

  /** @returns {Object|undefined} The highest registered version of `name`. */
  latest(name) {
    const versions = this._byName.get(name);
    return versions ? this._byId.get(`${name}@${versions[versions.length - 1]}`) : undefined;
  }

  /**
   * Plain-JSON listing of every registered procedure, sorted by id, for a
   * build step that publishes argument schemas across bundles.
   * @returns {{id: string, name: string, version: number, scope: string, replay: string, args: Object|null}[]}
   */
  manifest() {
    return [...this._byId.values()]
      .sort((a, b) =>
        a.name === b.name ? a.version - b.version : a.name < b.name ? -1 : 1,
      )
      .map(({ id, name, version, scope, replay, args }) => ({
        id,
        name,
        version,
        scope,
        replay,
        args: args === null ? null : jsonClone(args),
      }));
  }
}

module.exports = {
  defineProcedure,
  ProcedureRegistry,
  REPLAY_CLASSES,
  SCOPES,
  isDescriptor,
  parseProcedureId(id) {
    const m = typeof id === "string" ? ID.exec(id) : null;
    return m ? { name: m[1], version: Number(m[2]) } : null;
  },
};
