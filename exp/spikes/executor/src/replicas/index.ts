// Replicas are hand-written transcriptions of the product's call sequences.
// Each exports `run(mode, branch, params, env)` and runs the product's calls
// in the product's order: `serial` awaits them one by one, `parallel` groups
// the independent ones. The `remote` mode is not a replica concern: spike-data
// runs the replica in `serial` mode in process; it is the DO that forwards.
//
// A replica returns a string `outcome` so a run can assert it took the branch
// it was asked for (a replica that silently short-circuits measures nothing).
import type { Mode, Branch, ReplicaName } from "../shared";
import type { DbEnv } from "../db";
import * as subscribe from "./subscribe";
import * as message from "./message";
import * as invoke from "./invoke";
import * as ping from "./ping";

export interface Replica {
  /** Documented branches, for the driver's --help and for validation. */
  branches: readonly string[];
  run(mode: Exclude<Mode, "remote">, branch: Branch, params: Record<string, string>, env: DbEnv): Promise<string>;
}

export const replicas: Record<ReplicaName, Replica> = { subscribe, message, invoke, ping };
