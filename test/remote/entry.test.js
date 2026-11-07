/**
 * The published contract, checked the way the consumer sees it: from a
 * separate project whose node_modules/dynamo-bao points at this package.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const TSC = path.join(ROOT, "node_modules/typescript/bin/tsc");
const FIXTURE = path.join(__dirname, "types/consumer.ts");

const REMOTE_EXPORTS = [
  "CodecError",
  "DetachedInstanceError",
  "ProcedureRegistry",
  "REPLAY_CLASSES",
  "SCOPES",
  "bindModelsToTenant",
  "createContext",
  "createExecutor",
  "decodeRow",
  "defineProcedure",
  "encodeValue",
  "fresh",
  "inProcess",
  "remote",
];

let consumer;
beforeAll(() => {
  consumer = fs.mkdtempSync(path.join(os.tmpdir(), "bao-consumer-"));
  fs.mkdirSync(path.join(consumer, "node_modules"));
  fs.symlinkSync(ROOT, path.join(consumer, "node_modules/dynamo-bao"), "dir");
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
});
afterAll(() => fs.rmSync(consumer, { recursive: true, force: true }));

function node(args, opts = {}) {
  return execFileSync(process.execPath, args, { cwd: consumer, encoding: "utf8", ...opts });
}

describe("dynamo-bao/remote entry point", () => {
  test("require.resolve('dynamo-bao/remote') succeeds from a consumer checkout", () => {
    const resolved = node(["-e", "process.stdout.write(require.resolve('dynamo-bao/remote'))"]);
    expect(fs.realpathSync(resolved)).toBe(path.join(ROOT, "src/remote/index.js"));
  });

  test("CommonJS require exposes every export named in the changelog", () => {
    const keys = JSON.parse(
      node(["-e", "process.stdout.write(JSON.stringify(Object.keys(require('dynamo-bao/remote')).sort()))"]),
    );
    expect(keys).toEqual(REMOTE_EXPORTS);
  });

  test("ESM named imports work (bundlers and Workers import it this way)", () => {
    const out = node([
      "--input-type=module",
      "-e",
      "import { remote, inProcess, createExecutor, defineProcedure, ProcedureRegistry } from 'dynamo-bao/remote'; process.stdout.write(typeof remote + typeof inProcess + typeof createExecutor + typeof defineProcedure + typeof ProcedureRegistry)",
    ]);
    expect(out).toBe("function".repeat(5));
  });

  test("the root entry and its existing subpaths still resolve", () => {
    const out = node([
      "-e",
      "const b = require('dynamo-bao'); require('dynamo-bao/src/fields.js'); require('dynamo-bao/package.json'); process.stdout.write(typeof b.initModels + typeof b.BaoModel.fromRemote)",
    ]);
    expect(out).toBe("functionfunction");
  });

  test("the root entry's exports are unchanged (the remote API is only on the subpath)", () => {
    const keys = Object.keys(require("../../src")).sort();
    expect(keys).toEqual(
      [
        "BaoModel",
        "IndexConfig",
        "ModelManager",
        "PrimaryKeyConfig",
        "TenantContext",
        "UniqueConstraintConfig",
        "constants",
        "exceptions",
        "fields",
        "getBatchContextCapacity",
        "initModels",
        "models",
        "runWithBatchContext",
      ].sort(),
    );
  });

  test("the packed tarball ships the remote module and its declarations", () => {
    const [pack] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" }),
    );
    const files = pack.files.map((f) => f.path);
    for (const f of ["index.js", "index.d.ts", "procedures.js", "context.js", "codec.js", "executor.js", "client.js", "json.js"]) {
      expect(files).toContain(`src/remote/${f}`);
    }
    expect(files.some((f) => f.startsWith("examples/"))).toBe(false);
    expect(files.some((f) => f.startsWith("test/"))).toBe(false);
  });
});

describe("TypeScript contract", () => {
  function typecheck(compilerOptions) {
    const dir = fs.mkdtempSync(path.join(consumer, "ts-"));
    fs.copyFileSync(FIXTURE, path.join(dir, "consumer.ts"));
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          types: [],
          ...compilerOptions,
        },
        files: ["consumer.ts"],
      }),
    );
    try {
      execFileSync(process.execPath, [TSC, "-p", dir], { cwd: dir, encoding: "utf8" });
      return "";
    } catch (e) {
      return `${e.stdout}${e.stderr}`;
    }
  }

  // js-bao-wss compiles with module ES2022 and moduleResolution "node".
  test("a js-bao-wss resolver, procedures and caller type-check with the consumer's settings", () => {
    expect(typecheck({ module: "ES2022", moduleResolution: "node" })).toBe("");
  }, 60_000);

  test.each([
    ["bundler", { module: "ES2022", moduleResolution: "bundler" }],
    ["node16", { module: "node16", moduleResolution: "node16" }],
  ])("and with moduleResolution %s", (_label, opts) => {
    expect(typecheck(opts)).toBe("");
  }, 60_000);

  test("the expected type errors in the fixture really are errors", () => {
    // Remove every @ts-expect-error marker: the compile must then fail on
    // exactly those lines, proving each marked line is rejected for real.
    const src = fs.readFileSync(FIXTURE, "utf8");
    const marked = src.split("\n").filter((l) => /^\s*\/\/ @ts-expect-error/.test(l)).length;
    const dir = fs.mkdtempSync(path.join(consumer, "neg-"));
    fs.writeFileSync(path.join(dir, "consumer.ts"), src.replace(/^\s*\/\/ @ts-expect-error.*$/gm, ""));
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: "ES2022", lib: ["ES2022", "DOM"], types: [], module: "ES2022", moduleResolution: "node" },
        files: ["consumer.ts"],
      }),
    );
    let out = "";
    try {
      execFileSync(process.execPath, [TSC, "-p", dir], { cwd: dir, encoding: "utf8" });
    } catch (e) {
      out = `${e.stdout}`;
    }
    const errorLines = new Set([...out.matchAll(/consumer\.ts\((\d+),/g)].map((m) => m[1]));
    expect(marked).toBe(7);
    expect(errorLines.size).toBe(marked);
  }, 60_000);
});
