import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { traceColo } from "./trace";

/**
 * Two jobs.
 *
 * Spike 1: step "probe" calls spike-data through the service binding from
 * inside a Workflow and records both colos, because Workflows are the first
 * intended customer of the executor and are not covered by placement.
 *
 * Spike 5: step "sleep" sleeps `sleepMinutes`, then step "after" returns
 * env.BUILD_TAG. Redeploy with a different BUILD_TAG during the sleep. Result
 * 2026-10-28: "after" reported the new tag, so an in-flight instance runs
 * the newest deploy at its next step; instances are not version-pinned, and
 * the registry's previous-version rule only needs to span a deploy window.
 */
export interface SpikeWorkflowParams {
  sleepMinutes?: number;
}

type Env = {
  DATA: Fetcher;
  BUILD_TAG: string;
  SPIKE_TOKEN: string;
};

export class SpikeWorkflow extends WorkflowEntrypoint<Env, SpikeWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<SpikeWorkflowParams>>, step: WorkflowStep) {
    const probe = await step.do("probe", async () => {
      const t0 = performance.now();
      const res = await this.env.DATA.fetch("https://spike-data/ping", {
        headers: { authorization: `Bearer ${this.env.SPIKE_TOKEN}` },
      });
      const body = (await res.json()) as any;
      return { workflowColo: await traceColo(), dataColo: body.colo, roundTripMs: performance.now() - t0, data: body };
    });
    console.log(JSON.stringify({ spike: "workflow-probe", buildTag: this.env.BUILD_TAG, ...probe }));

    const minutes = event.payload.sleepMinutes ?? 0;
    if (minutes > 0) {
      await step.sleep("sleep", `${minutes} minutes`);
      const after = await step.do("after", async () => ({ buildTag: this.env.BUILD_TAG, at: new Date().toISOString() }));
      console.log(JSON.stringify({ spike: "workflow-version", startedUnder: "see first log line", ...after }));
      return { probe, after };
    }
    return { probe };
  }
}
