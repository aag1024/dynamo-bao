// Per-call timing of every DynamoDB command dynamo-bao sends, by wrapping the
// document client's `send`. One `Call` per command, with wall-clock start and
// end, so a sample reports both the serial depth (longest chain of
// non-overlapping calls: the number of round trips the path really waited
// for) and the per-call cost. This is what `runWithDynamoMetrics` in
// js-bao-wss measures for the fetch handler; here it is applied to the
// replicas instead of the product.
//
// Activated per sample with `recordCalls(fn)`; nested on AsyncLocalStorage so
// concurrent samples in one isolate do not mix.
import { AsyncLocalStorage } from "node:async_hooks";

export interface Call {
  op: string;        // DynamoDB operation, e.g. GetItem, Query, UpdateItem
  table: string;
  start: number;     // ms since sample start
  end: number;
  ok: boolean;
  error?: string;    // error name on failure (ConditionalCheckFailed...)
  rcu?: number;
  wcu?: number;
}

export interface CallReport {
  calls: Call[];
  totalMs: number;
  depth: number;     // serial round trips
  callMs: number;    // sum of call durations
}

const als = new AsyncLocalStorage<{ t0: number; calls: Call[] }>();
let patched = false;

function opName(command: any): string {
  const n = command?.constructor?.name ?? "Unknown";
  return n.replace(/Command$/, "");
}

function capacity(resp: any): { rcu?: number; wcu?: number } {
  const cc = resp?.ConsumedCapacity;
  const list = Array.isArray(cc) ? cc : cc ? [cc] : [];
  let rcu = 0, wcu = 0, any = false;
  for (const c of list) {
    if (c?.ReadCapacityUnits != null) { rcu += c.ReadCapacityUnits; any = true; }
    if (c?.WriteCapacityUnits != null) { wcu += c.WriteCapacityUnits; any = true; }
    if (c?.CapacityUnits != null && c.ReadCapacityUnits == null && c.WriteCapacityUnits == null) {
      rcu += c.CapacityUnits; any = true;
    }
  }
  return any ? { rcu, wcu } : {};
}

/** Patch the shared document client once. Idempotent. */
export function instrument(documentClient: any) {
  if (patched || !documentClient) return;
  patched = true;
  const send = documentClient.send.bind(documentClient);
  documentClient.send = async (command: any, ...rest: any[]) => {
    const store = als.getStore();
    if (!store) return send(command, ...rest);
    const call: Call = {
      op: opName(command),
      table: command?.input?.TableName ?? command?.input?.RequestItems ? "batch" : "?",
      start: performance.now() - store.t0,
      end: 0,
      ok: false,
    };
    store.calls.push(call);
    try {
      const resp = await send(command, ...rest);
      call.ok = true;
      Object.assign(call, capacity(resp));
      return resp;
    } catch (e: any) {
      call.error = e?.name ?? String(e);
      throw e;
    } finally {
      call.end = performance.now() - store.t0;
    }
  };
}

/** Longest chain of calls where each starts after the previous ended. */
export function serialDepth(calls: Call[]): number {
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  // Greedy interval chaining is optimal for "max non-overlapping" when sorted by end.
  const byEnd = [...sorted].sort((a, b) => a.end - b.end);
  let depth = 0, lastEnd = -Infinity;
  for (const c of byEnd) {
    if (c.start >= lastEnd) { depth++; lastEnd = c.end; }
  }
  return depth;
}

export async function recordCalls<T>(fn: () => Promise<T>): Promise<{ result: T; report: CallReport }> {
  const store = { t0: performance.now(), calls: [] as Call[] };
  const result = await als.run(store, fn);
  const totalMs = performance.now() - store.t0;
  return {
    result,
    report: {
      calls: store.calls,
      totalMs,
      depth: serialDepth(store.calls),
      callMs: store.calls.reduce((s, c) => s + (c.end - c.start), 0),
    },
  };
}
