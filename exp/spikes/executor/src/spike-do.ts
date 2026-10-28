import { DurableObject } from "cloudflare:workers";
import { execute, type ExecEnv } from "./execute";
import { traceColo } from "./trace";
import type { RunSpec, RunResult } from "./shared";

export type DoEnv = ExecEnv;

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
    return execute(spec, this.env);
  }
}
