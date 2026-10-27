// Replica of the DynamoDB work in `runInvocation`
// (functions-controller.ts:320-766) up to the sandbox call, transcribed
// 2026-10-27. The product runs it under the request's runWithBatchContext, so
// `serial` here is also under a batch context: finds with the default delay
// coalesce into BatchGetItem and repeat finds hit the loader cache.
//
//   1  resolveFunction: ServerFunction.findByfunctionKeyPerApp(key)
//        = raw GetItem on the unique-constraint row (never cached)
//        → ServerFunction.find(relatedId) (batched)
//   2  ServerFunctionConfig.find(activeConfigId)              (batched)
//   3  memberships, only if role is not admin/owner and access is non-empty:
//        AppMembership.queryByIndex(membershipsForApp, …) drained, no cache
//   4  RateLimitService.checkAndIncrement:
//        RateLimitWindow.update(id, { count: "+1" }, { condition: { count: { $lt: limit } } })
//        → on a missing row, RateLimitWindow.create({ …, count: 1, ttl })
//        → on a lost race, the increment again in a nested batch context
//        What dynamo-bao does inside update() (pre-read or not) is the
//        library version's business; the spike measures the working tree.
//   5  recordAppActivity, once per isolate-hour, in the admin partition:
//        App.find(appId) (batched) → App.update(…, { condition, instanceObj })
//
// Not modeled: the member permission middleware upstream, the sandbox, the
// finally-block decrement (only when the run was not "spent"), and the
// waitUntil invocation-log create (off the critical path).
//
// Branches:
//   admin               steps 1, 2, 4 (existing window row), no memberships, no activity
//   member              steps 1-5, existing window row, activity write due
//   member-new-window   as member but the window row is missing: update fails, create runs
//   member-limited      as member but the window row is at the limit: denied
//
// `parallel`: round 1 = [function lookup chain, memberships, App.find];
// round 2 = [config find, rate-limit increment, App.update]. The increment
// stays after the access decision so denied calls do not consume quota.
import { getAppModels, getAdminModels, withApp, withBatch } from "../db";
import type { DbEnv } from "../db";
import { drainMemberships } from "./auth";
import { required } from "./subscribe";

export const branches = ["admin", "member", "member-new-window", "member-limited"] as const;

const LIMIT = 60;
const WINDOW_SECONDS = 60;

export async function run(mode: "serial" | "parallel", branch: string, p: Record<string, string>, env: DbEnv) {
  const { appId, userId, functionKey } = required(p, ["appId", "userId", "functionKey"]);
  const member = branch !== "admin";
  // Seeded window rows: "existing" has count 1, "limited" has count LIMIT;
  // "new" uses a window start no one has written.
  const windowStart = branch === "member-new-window"
    ? new Date(Date.now()).toISOString()
    : branch === "member-limited" ? p.limitedWindowStart : p.existingWindowStart;
  if (!windowStart) throw new Error("missing window param for branch " + branch);

  const body = async () => {
    const M = getAppModels(env);
    const A = getAdminModels(env);
    const limitKey = p.limitKey ?? `functionInvoke_appId_${appId}_functionId_fn`;

    if (mode === "serial") {
      const fn = await M.ServerFunction.findByfunctionKeyPerApp(functionKey);
      if (!fn?.exists?.()) return "not-found";
      if (fn.activeConfigId) await M.ServerFunctionConfig.find(fn.activeConfigId);
      if (member) await drainMemberships(M, appId, userId);
      const rl = await checkAndIncrement(M, { limitKey, windowStart, appId });
      if (rl !== "allowed") return rl;
      if (member) await recordActivity(A, appId);
      return "allowed";
    }

    const [fn, , app] = await Promise.all([
      M.ServerFunction.findByfunctionKeyPerApp(functionKey),
      member ? drainMemberships(M, appId, userId) : Promise.resolve([]),
      member ? A.App.find(appId) : Promise.resolve(null),
    ]);
    if (!fn?.exists?.()) return "not-found";
    const [, rl] = await Promise.all([
      fn.activeConfigId ? M.ServerFunctionConfig.find(fn.activeConfigId) : Promise.resolve(null),
      checkAndIncrement(M, { limitKey, windowStart, appId }),
      member && app?.exists?.() ? updateActivity(A, app, appId) : Promise.resolve(),
    ]);
    return rl;
  };
  // Product: the whole request is one batch context; admin models run in the
  // global partition (no tenant) and app models under the app tenant.
  return withBatch(() => withApp(appId, body));
}

/** rate-limit.ts:126-252, the parts that touch DynamoDB. */
async function checkAndIncrement(M: any, k: { limitKey: string; windowStart: string; appId: string }): Promise<string> {
  const id = M.RateLimitWindow.makePrimaryId(k.limitKey, k.windowStart);
  const ttl = new Date(new Date(k.windowStart).getTime() + (WINDOW_SECONDS + 60) * 1000);
  const tryIncrement = async () => {
    try {
      await M.RateLimitWindow.update(id, { count: "+1" }, { condition: { count: { $lt: LIMIT } } });
      return "allowed";
    } catch (e: any) {
      if (e?.name === "ItemNotFoundError") return null;
      if (e?.name === "ConditionalError") {
        await M.RateLimitWindow.find(id); // the product re-reads to report the count
        return "limited";
      }
      throw e;
    }
  };
  const first = await tryIncrement();
  if (first) return first;
  try {
    await M.RateLimitWindow.create({ limitKey: k.limitKey, windowStart: k.windowStart, appId: k.appId, count: 1, ttl });
    return "allowed";
  } catch (e: any) {
    if (e?.name !== "ConditionalError") throw e;
  }
  const again = await withBatch(tryIncrement);
  return again ?? "unavailable";
}

/** app-activity-recorder.ts writeActivity, on a cold isolate (gate open). */
async function recordActivity(A: any, appId: string) {
  const app = await A.App.find(appId);
  if (!app?.exists?.() || app.deletingAt) return;
  await updateActivity(A, app, appId);
}

async function updateActivity(A: any, app: any, appId: string) {
  const now = new Date();
  const HOUR = 3_600_000;
  try {
    await A.App.update(app.getPrimaryId(), { lastActivityAt: now }, {
      condition: { $and: [{ appId }, { deletingAt: { $exists: false } }, { $or: [
        { lastActivityAt: { $exists: false } },
        { lastActivityAt: { $lt: now.getTime() - HOUR } },
      ] }] },
      instanceObj: app,
    });
  } catch (e: any) {
    if (e?.name !== "ConditionalError" && e?.name !== "ItemNotFoundError") throw e;
  }
}
