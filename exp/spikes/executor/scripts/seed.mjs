#!/usr/bin/env node
// Seed the spike table through spike-edge's /seed route, in chunks, resuming
// from whatever /status reports. `--docs N --peers P` (defaults 200 and 5).
import { loadEnv, api } from "./lib.mjs";

const { edge, token } = loadEnv();
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const docs = arg("docs", 200), peers = arg("peers", 5), chunk = 10;

const st = await api(edge, token, "/status");
let from = st.documents ?? 0;
if (from > 0) from -= 1; // the last probed doc may be partially seeded
console.log(`seeded so far: ${st.documents ?? 0} documents; seeding to ${docs}`);
for (; from < docs; from += chunk) {
  const r = await api(edge, token, "/seed", { from, to: Math.min(from + chunk, docs), peers });
  process.stdout.write(`  ${r.from}-${r.to}: +${r.created}\n`);
}
console.log(JSON.stringify(await api(edge, token, "/status")));
