// Replica of the per-Yjs-message check: `validateDocumentAccess`
// (connection-worker.ts:4604) plus what `forwardInTurn` does after it on a
// document the DO already knows. Transcribed 2026-10-27.
//
// With DOC_PERF_CACHE_ENABLED unset, every update/syncStep1/syncStep2 runs
// the full authorize chain (see auth.ts). On syncStep1 the product then also
// runs ensureConnectionMapping (a blind conditional create) every time.
//
// Branches: the same five as subscribe (owner, reader, group, link, deny).
// For `update` the product refuses reader and link levels in memory after
// the same reads, so "allowed:reader" here costs exactly what the product's
// refusal costs; the label is the auth level, not the product's verdict.
// Param `op`: "update" (default) or "syncStep1" (adds the mapping create).
//
// `parallel` is the restructuring: all four auth reads in one round under a
// batch context, so the check is one round trip whatever the branch.
import { getAppModels, withApp, withBatch } from "../db";
import type { DbEnv } from "../db";
import { authorize, type AuthReads } from "./auth";
import { required } from "./subscribe";

export const branches = ["owner", "reader", "group", "link", "deny"] as const;

export async function run(mode: "serial" | "parallel", _branch: string, p: Record<string, string>, env: DbEnv) {
  const { appId, documentId, userId, connectionId } = required(p, ["appId", "documentId", "userId", "connectionId"]);
  const op = p.op ?? "update";
  const body = async () => {
    const M = getAppModels(env);
    let level: string | null;
    if (mode === "serial") {
      level = await authorize(M, { appId, documentId, userId }, "serial");
    } else {
      const reads: AuthReads = {
        direct: M.DocumentPermission.find(M.DocumentPermission.makePrimaryId(documentId, userId)),
        memberships: M.AppMembership.queryByIndex("membershipsForApp", appId, { membershipKey: { $beginsWith: `${userId}#` } }),
        groups: M.DocumentGroupPermission.queryByIndex("groupPermissionsForDocument", documentId),
        document: M.Document.find(documentId),
      };
      level = await authorize(M, { appId, documentId, userId }, "parallel", reads);
    }
    if (!level) return "denied";
    if (op === "syncStep1") {
      try {
        await M.ConnectionMapping.create({ connectionId, userId, documentId, appId, ttl: new Date(Date.now() + 24 * 3600 * 1000) });
      } catch (e: any) {
        if (e?.name !== "ConditionalError" && e?.name !== "ConditionalCheckFailedException") throw e;
      }
    }
    return `allowed:${level}`;
  };
  return withApp(appId, () => (mode === "parallel" ? withBatch(body) : body()));
}
