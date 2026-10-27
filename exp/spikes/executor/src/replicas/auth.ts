// DocumentPermissionService.authorizeDocumentAction for "content.read"
// (js-bao-wss src/app-api/services/document-permission-service.ts:391-578),
// shared by the subscribe and message replicas. Transcribed 2026-10-27.
//
// serial (the product):
//   round 1  Promise.all([ DocumentPermission.find(doc#user),
//                          AppMembership.queryByIndex(membershipsForApp, appId,
//                            { membershipKey: { $beginsWith: `${userId}#` } }) drained ])
//   round 2  if direct is "owner": done (owner).
//            else if memberships non-empty:
//              DocumentGroupPermission.queryByIndex(groupPermissionsForDocument, doc), one page,
//              matched in memory on `${groupType}#${groupId}`.
//   round 3  if best explicit level < read-write: Document.find(doc) for linkAccess.
//
// parallel: the caller issues all four reads up front and passes the
// promises; this function only applies the decision logic to them.
//
// Level ordering is the product's PERMISSION_HIERARCHY: reader < read-write < owner.
const RANK: Record<string, number> = { reader: 1, "read-write": 2, owner: 3 };

export interface AuthReads {
  direct: Promise<any>;
  memberships: Promise<any>;
  groups: Promise<any>;
  document: Promise<any>;
}

export async function authorize(
  M: any,
  ids: { appId: string; documentId: string; userId: string },
  mode: "serial" | "parallel",
  reads?: AuthReads,
): Promise<string | null> {
  const { appId, documentId, userId } = ids;
  const directP = reads?.direct ?? M.DocumentPermission.find(M.DocumentPermission.makePrimaryId(documentId, userId));
  const membershipsP = reads?.memberships ?? drainMemberships(M, appId, userId);
  const [direct, memberships] = await Promise.all([directP, membershipsP]);
  const membershipItems: any[] = Array.isArray(memberships) ? memberships : memberships.items;

  let best = 0;
  if (direct?.exists?.()) {
    if (direct.permission === "owner") return "owner";
    best = RANK[direct.permission] ?? 0;
  }

  if (membershipItems.length > 0) {
    const groups = await (reads?.groups ?? M.DocumentGroupPermission.queryByIndex("groupPermissionsForDocument", documentId));
    const mine = new Set(membershipItems.map((m: any) => `${m.groupType}#${m.groupId}`));
    for (const g of groups.items) {
      if (mine.has(`${g.groupType}#${g.groupId}`)) best = Math.max(best, RANK[g.permission] ?? 0);
    }
  } else if (reads?.groups) {
    await reads.groups; // issued speculatively; the product would not have read it
  }

  if (best < RANK["read-write"]) {
    const doc = await (reads?.document ?? M.Document.find(documentId));
    if (doc?.exists?.() && doc.linkAccess) best = Math.max(best, RANK[doc.linkAccess] ?? 0);
  } else if (reads?.document) {
    await reads.document;
  }

  return best >= RANK.reader ? (Object.keys(RANK).find((k) => RANK[k] === best) ?? null) : null;
}

/** drainMembershipsForApp → queryAllPages: sequential pages until no lastEvaluatedKey. */
export async function drainMemberships(M: any, appId: string, userId: string): Promise<any[]> {
  const out: any[] = [];
  let startKey: any = undefined;
  do {
    const page = await M.AppMembership.queryByIndex(
      "membershipsForApp", appId, { membershipKey: { $beginsWith: `${userId}#` } }, startKey ? { startKey } : {},
    );
    out.push(...page.items);
    startKey = page.lastEvaluatedKey;
  } while (startKey);
  return out;
}
