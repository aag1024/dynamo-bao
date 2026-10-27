// Spike 1's probe: ten sequential finds on a key that does not exist. No
// branches. Measures per-call DynamoDB time from wherever it runs, with no
// item to deserialize, so the number is the network and DynamoDB floor.
import { getAppModels, withApp, withBatch } from "../db";
import type { DbEnv } from "../db";

export const branches = ["default"] as const;

export async function run(mode: "serial" | "parallel", _branch: string, params: Record<string, string>, env: DbEnv) {
  const appId = params.appId ?? "spike-app";
  return withApp(appId, async () => {
    const { Document } = getAppModels(env);
    const missing = "00000000000000000000000000"; // valid ULID shape, never seeded
    if (mode === "parallel") {
      // Ten finds in one tick coalesce into one BatchGetItem: the
      // "parallel" ping is the batching floor, not ten parallel calls.
      await withBatch(() => Promise.all(Array.from({ length: 10 }, () => Document.find(missing))));
    } else {
      for (let i = 0; i < 10; i++) await Document.find(missing);
    }
    return "ok";
  });
}
