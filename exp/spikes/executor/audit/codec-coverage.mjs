#!/usr/bin/env node
// Spike 4: which field types js-bao-wss's models use, model by model, and
// which of them are not JSON-safe as dynamo-bao stores them (binary, sets,
// dates). Read-only over the js-bao-wss checkout; writes nothing there.
//   node audit/codec-coverage.mjs [path/to/js-bao-wss/main]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "../../../../js-bao-wss/main");
const yaml = readFileSync(resolve(root, "models.yaml"), "utf8");

// A tiny reader for the subset of YAML models.yaml uses: `  Model:` at two
// spaces, `      field:` at six, `        type: X` at eight.
const models = {};
let model = null, field = null;
for (const raw of yaml.split("\n")) {
  const line = raw.replace(/\s+#.*$/, "");
  let m;
  if ((m = /^  ([A-Z]\w*):\s*$/.exec(line))) { model = m[1]; models[model] = {}; field = null; continue; }
  if (model && (m = /^      (\w+):\s*$/.exec(line))) { field = m[1]; continue; }
  if (model && field && (m = /^        type:\s*(\w+)/.exec(line))) { models[model][field] = m[1]; field = null; }
}

// How dynamo-bao stores each field type on the wire (src/fields.js), and
// whether JSON.stringify(_dyData) round-trips it unchanged.
const WIRE = {
  StringField: "S", EmailField: "S", UlidField: "S", RelatedField: "S", EnumField: "S",
  IntegerField: "N", FloatField: "N", CounterField: "N", VersionField: "N",
  BooleanField: "BOOL",
  DateTimeField: "N (ms)", CreateDateField: "N (ms)", ModifiedDateField: "N (ms)", TtlField: "N (s)",
  StringSetField: "SS", NumberSetField: "NS", BinaryField: "B", BinarySetField: "BS",
  ObjectField: "M", ListField: "L", JsonField: "S/M",
};
const NOT_JSON_SAFE = new Set(["SS", "NS", "B", "BS"]);

const byType = {};
const flagged = [];
for (const [name, fields] of Object.entries(models)) {
  for (const [f, t] of Object.entries(fields)) {
    byType[t] = (byType[t] ?? 0) + 1;
    const wire = WIRE[t] ?? "?";
    if (NOT_JSON_SAFE.has(wire) || wire === "?") flagged.push(`${name}.${f}: ${t} → ${wire}`);
  }
}
console.log(`${Object.keys(models).length} models, field types:`);
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t.padEnd(20)} ${WIRE[t] ?? "UNKNOWN to this script"}`);
console.log(`\nNot JSON-safe as stored (codec must handle), ${flagged.length} fields:`);
for (const f of flagged) console.log("  " + f);
console.log("\nDates are stored as numbers and survive JSON; instances need fromRemote to turn them back into Date.");
