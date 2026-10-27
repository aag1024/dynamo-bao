// Run one replica locally (serial or parallel) with per-call timing. Used by
// the DO (where the product's DOs would run it) and by spike-data (where the
// executor would). `remote` is handled by the DO, not here.
import { replicas } from "./replicas";
import { instrument, recordCalls } from "./timing";
import { getAdminModels } from "./db";
import type { DbEnv } from "./db";
import { traceColo } from "./trace";
import type { RunSpec, RunResult } from "./shared";

export async function runLocal(spec: RunSpec, env: DbEnv): Promise<RunResult> {
  if (spec.mode === "remote") throw new Error("runLocal cannot run remote mode");
  const replica = replicas[spec.replica];
  if (!replica) throw new Error(`unknown replica ${spec.replica}`);
  if (!replica.branches.includes(spec.branch)) {
    throw new Error(`replica ${spec.replica} has no branch ${spec.branch}; one of ${replica.branches.join(", ")}`);
  }
  // Every model class shares one document client per ModelManager instance;
  // initModels is cheap and idempotent, so grab a client and patch its send.
  instrument((getAdminModels(env) as any).App.documentClient);

  let outcome = "";
  let error: string | undefined;
  const { report } = await recordCalls(async () => {
    try {
      outcome = await replica.run(spec.mode as "serial" | "parallel", spec.branch, spec.params, env);
    } catch (e: any) {
      error = `${e?.name ?? "Error"}: ${e?.message ?? e}`;
      outcome = "error";
    }
  });
  return {
    spec,
    colo: await traceColo(),
    totalMs: report.totalMs,
    depth: report.depth,
    callMs: report.callMs,
    calls: report.calls.map((c) => ({ op: c.op, ms: c.end - c.start, ok: c.ok, ...(c.error ? { error: c.error } : {}) })),
    outcome,
    ...(error ? { error } : {}),
  };
}
