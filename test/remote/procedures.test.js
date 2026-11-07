const {
  defineProcedure,
  ProcedureRegistry,
  REPLAY_CLASSES,
  SCOPES,
} = require("../../src/remote/procedures");

const run = async () => ({ fine: true });

function proc(overrides = {}) {
  return defineProcedure({
    name: "rateLimit.reserve",
    version: 1,
    scope: "app",
    replay: "conditional",
    run,
    ...overrides,
  });
}

describe("defineProcedure", () => {
  test("returns a frozen descriptor addressed as name@version", () => {
    const d = proc({ args: { type: "object" } });
    expect(d.id).toBe("rateLimit.reserve@1");
    expect(d.name).toBe("rateLimit.reserve");
    expect(d.version).toBe(1);
    expect(d.scope).toBe("app");
    expect(d.replay).toBe("conditional");
    expect(d.args).toEqual({ type: "object" });
    expect(d.run).toBe(run);
    expect(Object.isFrozen(d)).toBe(true);
  });

  test("the frozen vocabularies are exactly the documented ones", () => {
    expect(REPLAY_CLASSES).toEqual(["idempotent", "conditional", "needs-ledger"]);
    expect(SCOPES).toEqual(["app", "admin", "both"]);
    expect(Object.isFrozen(REPLAY_CLASSES)).toBe(true);
    expect(Object.isFrozen(SCOPES)).toBe(true);
  });

  test.each(REPLAY_CLASSES)("accepts replay class %s", (replay) => {
    expect(proc({ replay }).replay).toBe(replay);
  });

  test.each(SCOPES)("accepts scope %s", (scope) => {
    expect(proc({ scope }).scope).toBe(scope);
  });

  test("refuses a procedure without a replay class", () => {
    expect(() => proc({ replay: undefined })).toThrow(/replay class/);
  });

  test("refuses an unknown replay class", () => {
    expect(() => proc({ replay: "read-only" })).toThrow(/replay class/);
  });

  test("refuses a procedure without a scope", () => {
    expect(() => proc({ scope: undefined })).toThrow(/scope/);
  });

  test("refuses an unknown scope", () => {
    expect(() => proc({ scope: "global" })).toThrow(/scope/);
  });

  test.each([undefined, "", "has@at", "has space", 7, "1leading"])(
    "refuses name %p",
    (name) => {
      expect(() => proc({ name })).toThrow(/name/);
    },
  );

  test.each([undefined, 0, -1, 1.5, "1", NaN])("refuses version %p", (version) => {
    expect(() => proc({ version })).toThrow(/version/);
  });

  test("refuses something that is not a descriptor object", () => {
    expect(() => defineProcedure(null)).toThrow(/descriptor object/);
  });

  test("refuses a missing run function", () => {
    expect(() => proc({ run: "nope" })).toThrow(/run/);
  });

  test("refuses an argument schema that is not plain JSON", () => {
    expect(() => proc({ args: { when: new Date() } })).toThrow(/args/);
    expect(() => proc({ args: () => true })).toThrow(/args/);
  });

  test("refuses unknown descriptor keys so a typo is not silently ignored", () => {
    expect(() => proc({ replayClass: "conditional" })).toThrow(/replayClass/);
  });
});

describe("ProcedureRegistry", () => {
  test("looks procedures up by name@version", () => {
    const a = proc();
    const b = proc({ name: "app.recordActivity", scope: "admin" });
    const registry = new ProcedureRegistry([a, b]);
    expect(registry.get("rateLimit.reserve@1")).toBe(a);
    expect(registry.get("app.recordActivity@1")).toBe(b);
    expect(registry.get("rateLimit.reserve@2")).toBeUndefined();
    expect(registry.get("nope@1")).toBeUndefined();
    expect(registry.has("rateLimit.reserve@1")).toBe(true);
    expect(registry.has("rateLimit.reserve@9")).toBe(false);
  });

  test("serves the previous version beside the current one while both are registered", () => {
    const v1 = proc();
    const v2 = proc({ version: 2, run: async () => ({ v: 2 }) });
    const registry = new ProcedureRegistry([v2, v1]);
    expect(registry.get("rateLimit.reserve@1")).toBe(v1);
    expect(registry.get("rateLimit.reserve@2")).toBe(v2);
    expect(registry.latest("rateLimit.reserve")).toBe(v2);
    expect(registry.versions("rateLimit.reserve")).toEqual([1, 2]);
  });

  test("dropping the previous descriptor stops serving it", () => {
    const registry = new ProcedureRegistry([proc({ version: 2 })]);
    expect(registry.get("rateLimit.reserve@1")).toBeUndefined();
    expect(registry.get("rateLimit.reserve@2")).toBeDefined();
  });

  test("refuses a version gap", () => {
    expect(() => new ProcedureRegistry([proc(), proc({ version: 3 })])).toThrow(
      /gap.*rateLimit\.reserve.*2/,
    );
  });

  test("refuses a duplicate name@version", () => {
    expect(() => new ProcedureRegistry([proc(), proc()])).toThrow(/rateLimit\.reserve@1/);
  });

  test("refuses anything that is not a defineProcedure descriptor", () => {
    expect(
      () =>
        new ProcedureRegistry([
          { name: "x", version: 1, scope: "app", replay: "conditional", run },
        ]),
    ).toThrow(/defineProcedure/);
    expect(() => new ProcedureRegistry("nope")).toThrow(/array/);
  });

  test("a new version may change scope or replay class", () => {
    expect(
      () => new ProcedureRegistry([proc(), proc({ version: 2, scope: "admin" })]),
    ).not.toThrow();
  });

  test("get refuses malformed ids without throwing", () => {
    const registry = new ProcedureRegistry([proc()]);
    for (const id of ["rateLimit.reserve", "@1", "rateLimit.reserve@x", 5, null]) {
      expect(registry.get(id)).toBeUndefined();
    }
  });

  test("manifest lists names, versions, scope, replay and arg schemas, sorted", () => {
    const registry = new ProcedureRegistry([
      proc({ version: 2, args: { type: "object", required: ["id"] } }),
      proc(),
      proc({ name: "app.recordActivity", scope: "admin", replay: "idempotent" }),
    ]);
    const manifest = registry.manifest();
    expect(manifest).toEqual([
      {
        id: "app.recordActivity@1",
        name: "app.recordActivity",
        version: 1,
        scope: "admin",
        replay: "idempotent",
        args: null,
      },
      {
        id: "rateLimit.reserve@1",
        name: "rateLimit.reserve",
        version: 1,
        scope: "app",
        replay: "conditional",
        args: null,
      },
      {
        id: "rateLimit.reserve@2",
        name: "rateLimit.reserve",
        version: 2,
        scope: "app",
        replay: "conditional",
        args: { type: "object", required: ["id"] },
      },
    ]);
    // The manifest is plain JSON, so it can be published across bundles.
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });

  test("is immutable after construction", () => {
    const registry = new ProcedureRegistry([proc()]);
    expect(Object.isFrozen(registry)).toBe(true);
  });
});
