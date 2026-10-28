// Seed layout. One app, five users with distinct grant shapes on every
// document, N documents, P peer connections per document, one function with
// an active config, and two rate-limit window rows. The driver picks a
// document by index so successive samples do not reuse one hot key.
//
// Everything is deterministic from (appId, index), so re-seeding is
// idempotent in effect (creates that collide are swallowed).
import { getAppModels, getAdminModels, withApp, withBatch } from "./db";
import type { DbEnv } from "./db";
import { ADMIN_TENANT, PLATFORM_RATE_PER_MINUTE, buildLimitKey } from "./limits";

export const APP_ID = "01JSP1KEAPP000000000000000";
export const USERS = {
  owner: "01JSP1KE0WNER0000000000000",
  reader: "01JSP1KEREADER000000000000",
  group: "01JSP1KEGRP000000000000000",
  link: "01JSP1KEANYB0DY00000000000",
  deny: "01JSP1KEDENY00000000000000",
} as const;
export const FUNCTION_KEY = "spike-fn";
export const CONFIG_ID = "01JSP1KECFG000000000000000";
export const EXISTING_WINDOW = "2026-01-01T00:00:00.000Z";
export const LIMITED_WINDOW = "2026-01-01T00:01:00.000Z";
export const FUNCTION_ID = "01JSP1KEFN0000000000000000";

export function docId(i: number) {
  return `01JSP1KED0C${String(i).padStart(15, "0")}`;
}
export function connId(i: number, j: number) {
  return `conn-${i}-${j}`;
}

export interface SeedSpec {
  /** Only fix linkAccess on already-seeded documents in [from, to); create nothing. */
  relinkOnly?: boolean;
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
      // The product creates and reads App rows under withAdminContext, so the
      // key is `[global-admin-app]#a#<appId>`; a bare `a#<appId>` row is invisible to it.
      if (await withApp(ADMIN_TENANT, () => swallowExists(A.App.create({ appId: APP_ID, name: "spike", mode: "test", createdBy: "01JSP1KEADM1N0000000000000" })))) created++;
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
          functionId: FUNCTION_ID, appId: APP_ID, functionKey: FUNCTION_KEY,
          activeConfigId: CONFIG_ID, access: "member", createdBy: "01JSP1KEADM1N0000000000000",
        }))) created++;
        if (await swallowExists(M.ServerFunctionConfig.create({
          configId: CONFIG_ID, functionId: FUNCTION_ID, appId: APP_ID,
          entry: "index.js", envelopeKey: "spike-envelope", createdBy: "01JSP1KEADM1N0000000000000",
        }))) created++;
        const far = new Date("2027-01-01T00:00:00Z");
        const limitKey = await buildLimitKey("functionInvoke", { appId: APP_ID, functionId: FUNCTION_ID });
        if (await swallowExists(M.RateLimitWindow.create({ limitKey, windowStart: EXISTING_WINDOW, appId: APP_ID, count: 1, ttl: far }))) created++;
        if (await swallowExists(M.RateLimitWindow.create({ limitKey, windowStart: LIMITED_WINDOW, appId: APP_ID, count: PLATFORM_RATE_PER_MINUTE, ttl: far }))) created++;
      }
      const metadata = "x".repeat(spec.metadataBytes ?? 2048);
      for (let i = spec.from; i < spec.to; i++) {
        const documentId = docId(i);
        // Even documents carry a link floor (the `link` branch); odd ones have
        // none, so the `deny` branch can be denied. The product stores no
        // attribute at all when link access is off.
        const linkAccess = i % 2 ? undefined : "reader";
        if (spec.relinkOnly) {
          const d = await M.Document.find(documentId);
          if (d.exists() && (d.linkAccess ?? undefined) !== linkAccess) {
            await M.Document.update(documentId, { linkAccess: linkAccess ?? null });
            created++;
          }
          continue;
        }
        const ops: Promise<any>[] = [
          M.Document.create({ documentId, appId: APP_ID, title: `doc ${i}`, createdBy: USERS.owner, metadata, linkAccess }),
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
