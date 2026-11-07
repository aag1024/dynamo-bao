/**
 * tutorials/11-remote-procedures.md freezes ProcedureContext, Actor, the
 * outcome tags and the replay classes (issue #18 item 3). This test fails if
 * the tutorial and what ships (index.d.ts and the runtime) disagree.
 */
const fs = require("fs");
const path = require("path");
const { REPLAY_CLASSES, SCOPES, createContext } = require("../../src/remote");

const tutorial = fs.readFileSync(path.join(__dirname, "../../tutorials/11-remote-procedures.md"), "utf8");
const dts = fs.readFileSync(path.join(__dirname, "../../src/remote/index.d.ts"), "utf8");

/** Member names of `interface <name> { ... }` in a TypeScript source. */
function members(source, name) {
  const start = source.indexOf(`interface ${name}`);
  if (start < 0) throw new Error(`no interface ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}" && --depth === 0) break;
  }
  const body = source
    .slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/^\s*(?:readonly\s+)?(\w+)\??(?:<[^>]*>)?\s*[:(]/gm)].map((m) => m[1]).sort();
}

function frozenSection() {
  const start = tutorial.indexOf("## The frozen contract");
  const end = tutorial.indexOf("\n## ", start + 1);
  return tutorial.slice(start, end);
}

test("ProcedureContext in the tutorial has exactly the shipped members", () => {
  const frozen = members(frozenSection(), "ProcedureContext");
  expect(frozen).toEqual(members(dts, "ProcedureContext"));
  expect(frozen).toEqual(
    ["actor", "adminModels", "config", "fresh", "logger", "models", "now", "operationId", "requestId", "tenant", "waitUntil"].sort(),
  );
});

test("the runtime context has exactly those members (adminModels only for admin scopes)", () => {
  const actor = { kind: "system", appId: "a", systemAuthority: false, preAuthenticated: false };
  const app = Object.keys(createContext({ tenant: "a", actor, models: {} })).sort();
  const admin = Object.keys(createContext({ tenant: "a", actor, models: {}, scope: "both", adminModels: {} })).sort();
  const frozen = members(frozenSection(), "ProcedureContext");
  expect(admin).toEqual(frozen);
  expect(app).toEqual(frozen.filter((m) => m !== "adminModels"));
});

test("Actor in the tutorial has exactly the shipped members", () => {
  const frozen = members(frozenSection(), "Actor");
  expect(frozen).toEqual(members(dts, "Actor"));
  expect(frozen).toEqual(["adminPartition", "appId", "kind", "preAuthenticated", "systemAuthority", "userId"]);
  expect(frozenSection()).toMatch(/kind: "user" \| "system" \| "admin";/);
  expect(dts).toMatch(/kind: "user" \| "system" \| "admin";/);
});

test("the replay classes in the tutorial are the shipped ones, in order", () => {
  const table = frozenSection().slice(frozenSection().indexOf("### Replay classes"));
  const rows = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
  expect(rows).toEqual([...REPLAY_CLASSES]);
  expect(dts).toMatch(/export type ReplayClass = "idempotent" \| "conditional" \| "needs-ledger";/);
});

test("the outcome tags in the tutorial are ok, error and unknown", () => {
  const table = frozenSection().slice(frozenSection().indexOf("### Outcomes"), frozenSection().indexOf("### Replay classes"));
  const tags = [...table.matchAll(/^\| `(\w+)` \| `\{/gm)].map((m) => m[1]);
  expect(tags).toEqual(["ok", "error", "unknown"]);
  expect(dts).toMatch(/export type Outcome<T> = OkOutcome<T> \| ErrorOutcome \| UnknownOutcome;/);
});

test("the scopes the tutorial uses are the shipped ones", () => {
  expect(tutorial).toMatch(/scope: "app",\s+\/\/ "app" \| "admin" \| "both"/);
  expect([...SCOPES]).toEqual(["app", "admin", "both"]);
});
