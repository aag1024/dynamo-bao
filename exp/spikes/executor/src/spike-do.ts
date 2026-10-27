import { DurableObject } from "cloudflare:workers";
import { runLocal } from "./run";
import { traceColo } from "./trace";
import type { RunSpec, RunResult, Transport } from "./shared";
import type { DbEnv } from "./db";

export type DoEnv = DbEnv & {
  DATA: Fetcher;
  DATA_RPC: Fetcher & { run(spec: RunSpec): Promise<RunResult>; ping(): Promise<any> };
  DATA_HOSTNAME?: string;
  SPIKE_TOKEN: string;
};

/**
 * Stands in for the product's DOs (ConnectionWorker, YjsRoomV2). One instance
 * per location hint, created by the edge worker with that hint, so each
 * instance runs where a product DO would if the product were unpinned and
 * the user were in that region.
 *
 *   serial / parallel   runs the replica here, talking to DynamoDB directly
 *                       from the DO's colo (what the product does today)
 *   remote              sends the spec to spike-data over the chosen
 *                       transport and reports the hop cost on top of what
 *                       spike-data measured for itself
 */
export class SpikeDO extends DurableObject<DoEnv> {
  async whereami(): Promise<{ colo: string | null }> {
    return { colo: await traceColo() };
  }

  async run(spec: RunSpec): Promise<RunResult> {
    if (spec.mode !== "remote") return runLocal(spec, this.env);

    const transport: Transport = spec.transport ?? "binding";
    const inner: RunSpec = { ...spec, mode: "serial", transport: undefined };
    const t0 = performance.now();
    let remote: RunResult;
    if (transport === "rpc") {
      remote = await this.env.DATA_RPC.run(inner);
    } else {
      // A service binding ignores the URL's host, so the hostname transport
      // must go through global fetch to reach spike-data over the public edge.
      const [doFetch, base] = transport === "hostname"
        ? [fetch, `https://${this.env.DATA_HOSTNAME}`]
        : [this.env.DATA.fetch.bind(this.env.DATA), "https://spike-data"];
      const res = await doFetch(`${base}/run`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.env.SPIKE_TOKEN}`, "content-type": "application/json" },
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
}
