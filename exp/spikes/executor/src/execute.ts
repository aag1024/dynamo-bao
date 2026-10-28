// Run a spec where this code is: locally (serial/parallel against DynamoDB
// from here) or remotely (one call to spike-data over the chosen transport,
// reporting the hop cost on top of what spike-data measured for itself).
// Shared by SpikeDO (the product's DO stand-in) and by the edge worker's
// `hint: "worker"` vantage, so a region-placed worker can be measured
// without a DO in the path.
import { runLocal } from "./run";
import { traceColo } from "./trace";
import type { RunSpec, RunResult, Transport } from "./shared";
import type { DbEnv } from "./db";

export type ExecEnv = DbEnv & {
  DATA: Fetcher;
  DATA_RPC: Fetcher & { run(spec: RunSpec): Promise<RunResult>; ping(): Promise<any> };
  DATA_HOSTNAME?: string;
  SPIKE_TOKEN: string;
};

export async function execute(spec: RunSpec, env: ExecEnv): Promise<RunResult> {
  if (spec.mode !== "remote") return runLocal(spec, env);

  const transport: Transport = spec.transport ?? "binding";
  const inner: RunSpec = { ...spec, mode: "serial", transport: undefined };
  const t0 = performance.now();
  let remote: RunResult;
  if (transport === "rpc") {
    remote = await env.DATA_RPC.run(inner);
  } else {
    // A service binding ignores the URL's host, so the hostname transport
    // must go through global fetch to reach spike-data over the public edge.
    const [doFetch, base] = transport === "hostname"
      ? [fetch, `https://${env.DATA_HOSTNAME}`]
      : [env.DATA.fetch.bind(env.DATA), "https://spike-data"];
    const res = await doFetch(`${base}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.SPIKE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(inner),
    });
    if (!res.ok) throw new Error(`spike-data ${res.status}: ${await res.text()}`);
    remote = (await res.json()) as RunResult;
  }
  const totalMs = performance.now() - t0;
  return {
    ...remote,
    spec,
    colo: await traceColo(),
    remoteColo: remote.colo,
    hopMs: totalMs - remote.totalMs,
    totalMs,
  };
}
