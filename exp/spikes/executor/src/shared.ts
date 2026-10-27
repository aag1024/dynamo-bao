// Vocabulary shared by the worker, the DO, the workflow and the laptop driver.

export const HINTS = ["wnam", "enam", "weur", "apac", "oc"] as const;
export type Hint = (typeof HINTS)[number];

export const REPLICAS = ["subscribe", "message", "invoke", "ping"] as const;
export type ReplicaName = (typeof REPLICAS)[number];

/**
 *   serial    the product's call order, awaited one after another
 *   parallel  the same calls under runWithBatchContext with the independent
 *             ones in one Promise.all (the "local restructuring" of Spike 3)
 *   remote    one call to spike-data, which runs `serial`-shaped code where
 *             the data is; the DO only waits for the answer
 */
export const MODES = ["serial", "parallel", "remote"] as const;
export type Mode = (typeof MODES)[number];

/** How the DO reaches spike-data in `remote` mode. Spike 1 compares them. */
export const TRANSPORTS = ["binding", "rpc", "hostname"] as const;
export type Transport = (typeof TRANSPORTS)[number];

/** Replica branches. Each replica documents what its branches mean. */
export type Branch = string;

export interface RunSpec {
  replica: ReplicaName;
  mode: Mode;
  branch: Branch;
  transport?: Transport;       // remote only; default "binding"
  /** Seeded ids the replica reads; see scripts/seed.mjs for the layout. */
  params: Record<string, string>;
  /** Free-form tag from the driver (run id, time of day), echoed back. */
  tag?: string;
}

export interface RunResult {
  spec: RunSpec;
  /** Colo the measuring code ran in (DO or data worker). */
  colo: string | null;
  /** For remote mode: colo the data worker reported, and the hop cost. */
  remoteColo?: string | null;
  hopMs?: number;              // totalMs seen by the DO minus data worker's own totalMs
  totalMs: number;
  depth: number;
  callMs: number;
  calls: { op: string; ms: number; ok: boolean; error?: string }[];
  outcome: string;             // replica-defined, e.g. "allowed", "denied", "limited"
  error?: string;
}
