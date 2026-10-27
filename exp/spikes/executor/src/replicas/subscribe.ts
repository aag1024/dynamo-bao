// Replica of js-bao-wss `handleDocumentSubscription` (connection-worker.ts:2013)
// as transcribed on 2026-10-27. Product facts the transcription rests on:
//
//   - The ConnectionWorker DO never opens a batch context, so in `serial`
//     mode every find is a direct, uncached GetItem (no withBatch here).
//   - DOC_PERF_CACHE_ENABLED is set in no environment, so the permission
//     cache is off and the loader always runs. The memberships SWR cache is
//     off in production. Neither is modeled.
//   - systemAuthorityFor and adminDocumentLevelFor are in-memory; the admin
//     bypass is not a branch here (it makes no DB calls at all).
//   - ensureConnectionMapping does a blind conditional create (no pre-read).
//   - The second Document.find runs on every new subscription and re-reads
//     the row the link floor may just have read.
//   - requestExistingAwarenessStates queries peers (limit 250, one page here)
//     and then fans out over DO fetches, which are not DynamoDB and are not
//     modeled. Its cleanup deletes run only for malformed rows; none seeded.
//
// Branches (which grant the seeded user has on the seeded document):
//   owner          direct grant "owner": group query and link floor skipped
//   reader         direct grant "reader": link floor runs, no memberships
//   group          no direct grant, one membership, group grant read-write
//   link           no grant, no membership, document.linkAccess = "reader"
//   deny           no grant, no membership, no link access: stops after auth
//
// `parallel` is the Spike 3 restructuring: one batch context, every read
// the auth might need issued speculatively in one round, then the mapping
// create and the peer query together in a second round. The routing
// Document.find becomes a loader-cache hit.
import { getAppModels, withApp, withBatch } from "../db";
import type { DbEnv } from "../db";
import { authorize, type AuthReads } from "./auth";

export const branches = ["owner", "reader", "group", "link", "deny"] as const;

export async function run(mode: "serial" | "parallel", branch: string, p: Record<string, string>, env: DbEnv) {
  const { appId, documentId, userId, connectionId } = required(p, ["appId", "documentId", "userId", "connectionId"]);
  const body = async () => {
    const M = getAppModels(env);
    const ttl = new Date(Date.now() + 24 * 3600 * 1000);

    if (mode === "serial") {
      // Steps 3-6: DocumentPermissionService.authorizeDocumentAction.
      const level = await authorize(M, { appId, documentId, userId }, "serial");
      if (!level) return "denied";
      // Step 8: ensureConnectionMapping, a conditional create; "existed" is swallowed.
      await createMapping(M, { connectionId, userId, documentId, appId, ttl });
      // Step 9: routing Document.find for a document this DO has not seen.
      await M.Document.find(documentId);
      // Step 10: requestExistingAwarenessStates → connectionsForDocument, one page.
      const peers = await M.ConnectionMapping.queryByIndex("connectionsForDocument", documentId, null, { limit: 250 });
      return `allowed:${level}:peers=${peers.items.length}`;
    }

    // parallel: round 1 is every read, round 2 is the writes and the peer query.
    const reads: AuthReads = {
      direct: M.DocumentPermission.find(M.DocumentPermission.makePrimaryId(documentId, userId)),
      memberships: M.AppMembership.queryByIndex("membershipsForApp", appId, { membershipKey: { $beginsWith: `${userId}#` } }),
      groups: M.DocumentGroupPermission.queryByIndex("groupPermissionsForDocument", documentId),
      document: M.Document.find(documentId),
    };
    const level = await authorize(M, { appId, documentId, userId }, "parallel", reads);
    if (!level) return "denied";
    const [, peers] = await Promise.all([
      createMapping(M, { connectionId, userId, documentId, appId, ttl }),
      M.ConnectionMapping.queryByIndex("connectionsForDocument", documentId, null, { limit: 250 }),
      M.Document.find(documentId), // loader-cache hit: no call
    ]);
    return `allowed:${level}:peers=${peers.items.length}`;
  };
  return withApp(appId, () => (mode === "parallel" ? withBatch(body) : body()));
}

async function createMapping(M: any, fields: Record<string, unknown>) {
  try {
    await M.ConnectionMapping.create(fields);
    return true;
  } catch (e: any) {
    if (e?.name === "ConditionalError" || e?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

export function required(p: Record<string, string>, keys: string[]) {
  for (const k of keys) if (!p[k]) throw new Error(`missing param ${k}`);
  return p as Record<string, string>;
}
