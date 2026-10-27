import { WorkerEntrypoint } from "cloudflare:workers";
import { SpikeDO, type DoEnv } from "./spike-do";
import { SpikeWorkflow } from "./spike-workflow";
import { runLocal } from "./run";
import { traceColo } from "./trace";
import { seed, status } from "./seed";
import { HINTS, type Hint, type RunSpec } from "./shared";

export { SpikeDO, SpikeWorkflow };

/**
 * One script, two roles (env.ROLE):
 *
 *   data   the executor stand-in. POST /run executes a replica here and
 *          reports the colo it ran in. GET /ping is Spike 1's probe. Also
 *          exposed as the RPC entrypoint `DataEntrypoint` below.
 *   edge   the product's edge. POST /run hands a spec to the SpikeDO for the
 *          requested hint (serial/parallel run there; remote forwards to
 *          data). POST /seed and GET /status manage the table. POST /workflow
 *          starts SpikeWorkflow.
 *
 * Every route needs `authorization: Bearer <SPIKE_TOKEN>`.
 */
type Env = DoEnv & {
  ROLE: "edge" | "data";
  PLACEMENT: string;
  BUILD_TAG: string;
  SPIKE: DurableObjectNamespace<SpikeDO>;
  SPIKE_WORKFLOW: Workflow;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function authorized(request: Request, env: Env): boolean {
  return request.headers.get("authorization") === `Bearer ${env.SPIKE_TOKEN}`;
}

async function here(request: Request, env: Env) {
  return { role: env.ROLE, placement: env.PLACEMENT, buildTag: env.BUILD_TAG, enteredAt: (request.cf as any)?.colo ?? null, ranAt: await traceColo() };
}

async function dataRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/ping") {
    const r = await runLocal({ replica: "ping", mode: "serial", branch: "default", params: {} }, env);
    return json({ ...(await here(request, env)), ...r });
  }
  if (url.pathname === "/run" && request.method === "POST") {
    const spec = (await request.json()) as RunSpec;
    if (spec.mode === "remote") return json({ error: "data worker runs serial or parallel only" }, 400);
    return json(await runLocal(spec, env));
  }
  return json({ error: "not found" }, 404);
}

async function edgeRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/run" && request.method === "POST") {
    const body = (await request.json()) as RunSpec & { hint: Hint | "none" };
    const { hint, ...spec } = body;
    const name = hint ?? "none";
    if (name !== "none" && !HINTS.includes(name)) return json({ error: `hint must be one of none, ${HINTS.join(", ")}` }, 400);
    const stub = name === "none"
      ? env.SPIKE.get(env.SPIKE.idFromName("none"))
      : env.SPIKE.get(env.SPIKE.idFromName(name), { locationHint: name });
    const t0 = performance.now();
    const result = await stub.run(spec);
    return json({ hint: name, edge: await here(request, env), edgeToDoMs: performance.now() - t0 - result.totalMs, ...result });
  }
  if (url.pathname === "/whereami") {
    const out: Record<string, unknown> = { edge: await here(request, env) };
    for (const h of [...HINTS, "none"] as const) {
      const stub = h === "none" ? env.SPIKE.get(env.SPIKE.idFromName("none")) : env.SPIKE.get(env.SPIKE.idFromName(h), { locationHint: h });
      out[h] = await stub.whereami();
    }
    return json(out);
  }
  if (url.pathname === "/seed" && request.method === "POST") {
    return json(await seed((await request.json()) as any, env));
  }
  if (url.pathname === "/status") {
    return json(await status(env));
  }
  if (url.pathname === "/workflow" && request.method === "POST") {
    const params = (await request.json().catch(() => ({}))) as { sleepMinutes?: number };
    const instance = await env.SPIKE_WORKFLOW.create({ params });
    return json({ id: instance.id, buildTag: env.BUILD_TAG });
  }
  if (url.pathname.startsWith("/workflow/")) {
    const instance = await env.SPIKE_WORKFLOW.get(url.pathname.slice("/workflow/".length));
    return json(await instance.status());
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return json(await here(request, env));
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    try {
      return env.ROLE === "data" ? await dataRoutes(request, env, url) : await edgeRoutes(request, env, url);
    } catch (e: any) {
      return json({ error: `${e?.name ?? "Error"}: ${e?.message ?? e}`, stack: e?.stack }, 500);
    }
  },
};

/** Spike 1: the same data worker over RPC. Placement docs say RPC is not placed. */
export class DataEntrypoint extends WorkerEntrypoint<Env> {
  async run(spec: RunSpec) {
    return runLocal(spec, this.env);
  }
  async ping() {
    const r = await runLocal({ replica: "ping", mode: "serial", branch: "default", params: {} }, this.env);
    return { role: this.env.ROLE, placement: this.env.PLACEMENT, ranAt: await traceColo(), ...r };
  }
}
