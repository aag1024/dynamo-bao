// The mount: the library supplies the executor; this file supplies the three
// application decisions (how to build models, who may call, how much).
import { createExecutor } from "dynamo-bao/remote";
import { procedures } from "./procedures.js";
import { getModels } from "./models.js";

/** Compare the ingress secret without an early exit on the first mismatch. */
function sameSecret(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || expected === "") return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export const DATA_ROUTE = "/_data/call";
export const SECRET_HEADER = "x-data-binding";

export const executor = createExecutor({
  procedures,
  // The context resolver: the library calls it once per call, inside the
  // call's tenant and batch context.
  context: (call, env) => ({
    models: getModels(env),
    config: { LOG_LEVEL: env.LOG_LEVEL ?? "info" },
  }),
  // The ingress secret: the route is public in the single-bundle layout, so
  // only requests carrying the binding secret may run procedures.
  ingress: (request, env) => sameSecret(request.headers.get(SECRET_HEADER), env.DATA_BINDING_SECRET),
  budget: { maxCalls: 8, maxResponseBytes: 1_000_000 },
  region: "aws:us-west-2",
});
