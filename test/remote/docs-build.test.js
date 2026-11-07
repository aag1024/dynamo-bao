/**
 * `npm run docs` is a release step, so the remote module's JSDoc must parse
 * and the example app must stay out of the API reference.
 */
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const JSDOC = path.join(ROOT, "node_modules/jsdoc/jsdoc.js");

let run;
let doclets;
beforeAll(() => {
  run = spawnSync(process.execPath, [JSDOC, "-c", "jsdoc.json", "-X"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  doclets = run.status === 0 ? JSON.parse(run.stdout) : [];
}, 120_000);

describe("API docs build", () => {
  test("jsdoc parses every comment without errors", () => {
    expect(run.stderr).not.toMatch(/ERROR/);
    expect(run.status).toBe(0);
  });

  test("documents the remote modules", () => {
    const modules = doclets.filter((d) => d.kind === "module").map((d) => d.name);
    for (const m of ["remote/procedures", "remote/context", "remote/codec", "remote/executor", "remote/client"]) {
      expect(modules).toContain(m);
    }
  });

  test("leaves the example app and experiments out of the reference", () => {
    expect(doclets.length).toBeGreaterThan(0);
    const files = new Set(doclets.map((d) => d.meta && d.meta.path).filter(Boolean));
    const stray = [...files].filter((p) => /^(examples|exp)([\\/]|$)/.test(path.relative(ROOT, p)));
    expect(stray).toEqual([]);
  });
});
