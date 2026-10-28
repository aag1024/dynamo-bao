#!/usr/bin/env node
// The load generator. Loops over { hint × replica × mode × branch [× transport] }
// and writes one CSV row per sample to results/<run>.csv. Where the laptop is
// does not matter: the measured quantity is DO-to-DynamoDB and DO-to-data
// time, and edgeToDoMs is reported separately. Hints are the DO location
// hints, plus "none" (a DO with no hint) and "worker" (no DO: the spec runs
// in the edge worker itself, which with --edge use1 is a worker placed in
// aws:us-east-1).
//
//   node scripts/run.mjs                       the default matrix, 50 warm + 10 cold
//   node scripts/run.mjs --hints weur,oc --replicas subscribe --modes serial,remote
//                        --branches owner,deny --transports binding,hostname
//                        --warm 20 --cold 5 --edge use1 --tag evening
//
// "cold" samples are spaced 90 s apart so the DO and data isolates are likely
// evicted between them; "warm" samples run back to back. Each sample uses the
// next seeded document so no single partition is hot.
import { appendFileSync, mkdirSync } from "node:fs";
import { loadEnv, api } from "./lib.mjs";

const env = loadEnv();
const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const list = (k, d) => opt(k, d).split(",").filter(Boolean);
if (process.argv.includes("--help")) { console.log(await import("node:fs").then(f => f.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 14).join("\n"))); process.exit(0); }

const hints = list("hints", "wnam,enam,weur,apac,oc");
const replicas = list("replicas", "subscribe,message,invoke,ping");
const modes = list("modes", "serial,parallel,remote");
const branchesOpt = opt("branches", "");
const transports = list("transports", "binding");
const warm = Number(opt("warm", 50)), cold = Number(opt("cold", 10));
const edge = opt("edge", "default") === "use1" ? env.edgeUse1 : env.edge;
const tag = opt("tag", new Date().toISOString().slice(0, 16));
const run = `${tag.replace(/[^\w-]/g, "_")}`;

const BRANCHES = {
  subscribe: ["owner", "reader", "group", "link", "deny"],
  message: ["owner", "reader", "group", "link", "deny"],
  invoke: ["admin", "member", "member-new-window", "member-limited"],
  ping: ["default"],
};
const USERS = { owner: "01JSP1KE0WNER0000000000000", reader: "01JSP1KEREADER000000000000", group: "01JSP1KEGRP000000000000000", link: "01JSP1KEANYB0DY00000000000", deny: "01JSP1KEDENY00000000000000" };
const APP = "01JSP1KEAPP000000000000000";
const docId = (i) => `01JSP1KED0C${String(i).padStart(15, "0")}`;

const status = await api(env.edge, env.token, "/status");
const docs = status.documents ?? 0;
if (!docs) throw new Error("table not seeded; run scripts/seed.mjs");
let docCursor = 0;
let connCursor = 0;

function paramsFor(replica, branch) {
  const i = docCursor++ % docs;
  const user = USERS[branch] ?? USERS.owner;
  switch (replica) {
    case "subscribe":
    case "message":
      return { appId: APP, documentId: docId(i), userId: user, connectionId: `run-${run}-${connCursor++}` };
    case "invoke":
      return { appId: APP, userId: branch === "admin" ? USERS.owner : USERS.group, functionKey: "spike-fn",
        existingWindowStart: "2026-01-01T00:00:00.000Z", limitedWindowStart: "2026-01-01T00:01:00.000Z",
        limitKey: `functionInvoke_appId_${APP}_functionId_fn` };
    default:
      return { appId: APP };
  }
}

mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const csv = new URL(`../results/${run}.csv`, import.meta.url);
const header = "run,at,temp,edge,hint,replica,mode,transport,branch,outcome,colo,remoteColo,entered,totalMs,hopMs,edgeToDoMs,depth,callMs,calls,error\n";
appendFileSync(csv, header);
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function sample(temp, hint, replica, mode, transport, branch) {
  const spec = { hint, replica, mode, branch, params: paramsFor(replica, branch), tag: run, ...(mode === "remote" ? { transport } : {}) };
  const r = await api(edge, env.token, "/run", spec);
  const row = [run, new Date().toISOString(), temp, opt("edge", "default"), hint, replica, mode, mode === "remote" ? transport : "", branch,
    r.outcome, r.colo, r.remoteColo, r.edge?.enteredAt, r.totalMs?.toFixed(1), r.hopMs?.toFixed(1), r.edgeToDoMs?.toFixed(1),
    r.depth, r.callMs?.toFixed(1), r.calls?.map((c) => `${c.op}:${c.ms.toFixed(0)}${c.ok ? "" : "!"}`).join(" "), r.error];
  appendFileSync(csv, row.map(q).join(",") + "\n");
  return r;
}

const cells = [];
for (const hint of hints) for (const replica of replicas) for (const mode of modes)
  for (const branch of (branchesOpt ? branchesOpt.split(",") : BRANCHES[replica]))
    for (const transport of (mode === "remote" ? transports : [""])) cells.push({ hint, replica, mode, transport, branch });
console.log(`${cells.length} cells × (${warm} warm + ${cold} cold) → ${csv.pathname}`);

for (const c of cells) {
  const label = `${c.hint} ${c.replica} ${c.mode}${c.transport ? "/" + c.transport : ""} ${c.branch}`;
  const ms = [];
  for (let i = 0; i < warm; i++) {
    const r = await sample("warm", c.hint, c.replica, c.mode, c.transport, c.branch);
    ms.push(r.totalMs);
    if (i === 0 && r.outcome?.startsWith("error")) { console.log(`  ${label}: ${r.error}`); break; }
  }
  ms.sort((a, b) => a - b);
  const p = (f) => ms[Math.min(ms.length - 1, Math.floor(f * ms.length))]?.toFixed(0);
  console.log(`  ${label}: n=${ms.length} p50=${p(0.5)} p95=${p(0.95)} ms`);
}
if (cold > 0) {
  console.log(`cold samples: ${cold} rounds, 90 s apart`);
  for (let i = 0; i < cold; i++) {
    await new Promise((r) => setTimeout(r, 90_000));
    for (const c of cells) await sample("cold", c.hint, c.replica, c.mode, c.transport, c.branch);
    process.stdout.write(`  cold round ${i + 1}/${cold}\n`);
  }
}
console.log("done:", csv.pathname);
