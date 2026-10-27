#!/usr/bin/env node
// p50/p95 per cell from one or more results CSVs. `node scripts/summarize.mjs results/*.csv`
import { readFileSync } from "node:fs";
const rows = [];
for (const f of process.argv.slice(2)) {
  const [head, ...lines] = readFileSync(f, "utf8").trim().split("\n");
  const cols = head.split(",");
  for (const l of lines) {
    const vals = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((v) => v.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i]])));
  }
}
const groups = new Map();
for (const r of rows) {
  const k = [r.temp, r.edge, r.hint, r.replica, r.mode, r.transport, r.branch].join(" ");
  (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
}
const pct = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
console.log("temp edge hint replica mode transport branch | n depth colo→remote | total p50 p95 | hop p50 | calls p50");
for (const [k, rs] of [...groups].sort()) {
  const tot = rs.map((r) => +r.totalMs), hop = rs.map((r) => +r.hopMs).filter((x) => !Number.isNaN(x));
  const colo = [...new Set(rs.map((r) => r.colo))].join("/"), rc = [...new Set(rs.map((r) => r.remoteColo).filter(Boolean))].join("/");
  console.log(`${k} | n=${rs.length} d=${pct(rs.map((r) => +r.depth), 0.5)} ${colo}${rc ? "→" + rc : ""} | ${pct(tot, 0.5).toFixed(0)} ${pct(tot, 0.95).toFixed(0)} | ${hop.length ? pct(hop, 0.5).toFixed(0) : "-"} | ${pct(rs.map((r) => +r.callMs), 0.5).toFixed(0)}`);
}
