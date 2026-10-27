// Seed layout. One app, five users with distinct grant shapes on every
// document, N documents, P peer connections per document, one function with
// an active config, and two rate-limit window rows. The driver picks a
// document by index so successive samples do not reuse one hot key.
//
// Everything is deterministic from (appId, index), so re-seeding is
// idempotent in effect (creates that collide are swallowed).
import { getAppModels, getAdminModels, withApp, withBatch } from "./db";
import type { DbEnv } from "./db";

export const APP_ID = "01SPIKEAPP0000000000000000";
export const USERS = {
  owner: "01SPIKEUSEROWNER0000000000",
  reader: "01SPIKEUSERREADER000000000",
  group: "01SPIKEUSERGROUP0000000000",
  link: "01SPIKEUSERLINK00000000000",
  deny: "01SPIKEUSERDENY00000000000",
} as const;
export const FUNCTION_KEY = "spike-fn";
export const CONFIG_ID = "01SPIKECFG0000000000000000";
export const EXISTING_WINDOW = "2026-01-01T00:00:00.000Z";
export const LIMITED_WINDOW = "2026-01-01T00:01:00.000Z";
export const LIMIT_KEY = `functionInvoke_appId_${APP_ID}_functionId_fn`;

export function docId(i: number) {
  return `01SPIKEDOC${String(i).padStart(16, "0")}`;
}
export function connId(i: number, j: number) {
  return `conn-${i}-${j}`;
}

export interface SeedSpec {
  from: number;   // document index range [from, to)
  to: number;
  peers: number;  // connection mappings per document
  metadataBytes?: number; // size of Document.metadata, default 2 KB
}

async function swallowExists<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch (e: any) {
    if (e?.name === "ConditionalError" || /ConditionalCheckFailed/.test(e?.message ?? "")) return null;
    throw e;
  }
}

export async function seed(spec: SeedSpec, env: DbEnv) {
  const A = getAdminModels(env);
  let created = 0;
  await withBatch(async () => {
    if (spec.from === 0) {
      if (await swallowExists(A.App.create({ appId: APP_ID, name: "spike", mode: "test", createdBy: "01SPIKEADMIN00000000000000" }))) created++;
    }
    await withApp(APP_ID, async () => {
      const M = getAppModels(env);
      if (spec.from === 0) {
        for (const [k, userId] of Object.entries(USERS)) {
          if (await swallowExists(M.User.create({ userId, email: `${k}@spike.test`, provider: "test" }))) created++;
        }
        if (await swallowExists(M.AppMembership.create({
          appId: APP_ID, membershipKey: `${USERS.group}#team#t1`, userId: USERS.group,
          groupType: "team", groupId: "t1", groupComposite: "team#t1", addedBy: USERS.owner,
        }))) created++;
        if (await swallowExists(M.ServerFunction.create({
          functionId: "01SPIKEFN00000000000000000", appId: APP_ID, functionKey: FUNCTION_KEY,
          activeConfigId: CONFIG_ID, access: "member", createdBy: "01SPIKEADMIN00000000000000",
        }))) created++;
        if (await swallowExists(M.ServerFunctionConfig.create({
          configId: CONFIG_ID, functionId: "01SPIKEFN00000000000000000", appId: APP_ID,
          entry: "index.js", envelopeKey: "spike-envelope", createdBy: "01SPIKEADMIN00000000000000",
        }))) created++;
        const far = new Date("2027-01-01T00:00:00Z");
        if (await swallowExists(M.RateLimitWindow.create({ limitKey: LIMIT_KEY, windowStart: EXISTING_WINDOW, appId: APP_ID, count: 1, ttl: far }))) created++;
        if (await swallowExists(M.RateLimitWindow.create({ limitKey: LIMIT_KEY, windowStart: LIMITED_WINDOW, appId: APP_ID, count: 60, ttl: far }))) created++;
      }
      const metadata = "x".repeat(spec.metadataBytes ?? 2048);
      for (let i = spec.from; i < spec.to; i++) {
        const documentId = docId(i);
        const ops: Promise<any>[] = [
          M.Document.create({ documentId, appId: APP_ID, title: `doc ${i}`, createdBy: USERS.owner, metadata, linkAccess: "reader" }),
          M.DocumentPermission.create({ documentId, userId: USERS.owner, permission: "owner", grantedBy: USERS.owner }),
          M.DocumentPermission.create({ documentId, userId: USERS.reader, permission: "reader", grantedBy: USERS.owner }),
          M.DocumentGroupPermission.create({
            documentId, groupComposite: "team#t1", groupType: "team", groupId: "t1",
            appGroupComposite: `${APP_ID}#team#t1`, permission: "read-write", grantedBy: USERS.owner,
          }),
        ];
        for (let j = 0; j < spec.peers; j++) {
          ops.push(M.ConnectionMapping.create({
            connectionId: connId(i, j), userId: USERS.owner, appId: APP_ID, documentId, ttl: new Date("2027-01-01T00:00:00Z"),
          }));
        }
        const results = await Promise.all(ops.map(swallowExists));
        created += results.filter(Boolean).length;
      }
    });
  });
  return { created, from: spec.from, to: spec.to };
}

export async function status(env: DbEnv) {
  return withApp(APP_ID, async () => {
    const M = getAppModels(env);
    const probe = async (i: number) => (await M.Document.find(docId(i))).exists();
    // Binary search the highest seeded document index, for resumable seeding.
    let lo = 0, hi = 1 << 16;
    if (!(await probe(0))) return { documents: 0 };
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await probe(mid)) lo = mid; else hi = mid; }
    const peers = await M.ConnectionMapping.queryByIndex("connectionsForDocument", docId(0), null, { limit: 250 });
    return { documents: lo + 1, peersOnDoc0: peers.items.length, appId: APP_ID, users: USERS };
  });
}
