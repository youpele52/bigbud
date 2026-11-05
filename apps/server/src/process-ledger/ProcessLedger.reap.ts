/**
 * Startup reaping of children recorded by a dead backend.
 *
 * A record is killed only with proof on both sides: its owner backend is provably dead (lock rules:
 * ESRCH or a different start time for the owner PID, same host), and the child still has exactly
 * the recorded start token, a command line ending in the recorded arguments, and, for `group`
 * records, still leads its own process group. Anything unprovable is never signalled; nothing is
 * ever matched by process name alone.
 *
 * @module ProcessLedger.reap
 */
import { compareProcessStartToken } from "@bigbud/shared/processStartToken";
import { Duration, Effect } from "effect";

import type { BackendInstanceShape } from "../startup/backendInstance.ts";
import {
  processAlive,
  processGroupAlive,
  signalProcess,
  signalProcessGroup,
} from "../utils/processGroup.ts";
import { commandLineMatches, type ProcessLedgerRecord } from "./ProcessLedger.record.ts";
import {
  descendantsOf,
  type ProcessTable,
  type ProcessTableRow,
  readProcessTable,
  rowStartToken,
} from "./ProcessLedger.snapshot.ts";

/** SIGTERM-to-SIGKILL window for reaped orphans, matching the ACP agent release. */
export const PROCESS_LEDGER_REAP_GRACE = Duration.seconds(2);
const REAP_POLL = Duration.millis(50);
/** Upper bound on waiting for the exit after SIGKILL. */
const SIGKILL_EXIT_WAIT = Duration.seconds(1);

export type ProcessLedgerDecision =
  /** Not ours to judge (this backend, a live or foreign owner): leave the record alone. */
  | { readonly action: "keep"; readonly reason: "own" | "owner-live" | "owner-foreign-host" }
  /** The recorded child is gone or no longer provably the same process: forget it, kill nothing. */
  | {
      readonly action: "drop";
      readonly reason:
        | "gone"
        | "pid-reused"
        | "identity-unknown"
        | "command-mismatch"
        | "not-group-leader";
    }
  | { readonly action: "kill"; readonly targets: ProcessLedgerKillTargets };

export interface ProcessLedgerKillTarget {
  readonly pid: number;
  /** Proven at decision time; re-proven before SIGKILL, so a PID reused meanwhile is spared. */
  readonly startToken: string;
}

export interface ProcessLedgerKillTargets {
  readonly kill: ProcessLedgerRecord["kill"];
  /**
   * The recorded child first. `group`: then the other members of its process group at snapshot
   * time; SIGTERM goes to the PGID, SIGKILL only to these processes, re-proven. `tree`: then its
   * descendants by parent PID at snapshot time (they may be in other groups). Processes whose
   * identity is unobtainable are never included.
   */
  readonly processes: ReadonlyArray<ProcessLedgerKillTarget>;
}

export interface ProcessLedgerDecisionContext {
  readonly selfNonce: string;
  readonly classifyOwner: BackendInstanceShape["classifyOwner"];
  readonly table: ProcessTable;
  readonly startTokenOf?: (row: ProcessTableRow) => string | undefined;
}

export function decideProcessLedgerRecord(
  record: ProcessLedgerRecord,
  context: ProcessLedgerDecisionContext,
): ProcessLedgerDecision {
  if (record.owner.nonce === context.selfNonce) return { action: "keep", reason: "own" };
  const owner = context.classifyOwner(record.owner);
  if (owner === "live") return { action: "keep", reason: "owner-live" };
  if (owner === "foreign-host") return { action: "keep", reason: "owner-foreign-host" };

  const row = context.table.get(record.pid);
  if (!row) return { action: "drop", reason: "gone" };
  const identity = compareProcessStartToken(
    record.startToken,
    (context.startTokenOf ?? rowStartToken)(row),
  );
  if (identity === "different") return { action: "drop", reason: "pid-reused" };
  if (identity === "unknown") return { action: "drop", reason: "identity-unknown" };
  if (!commandLineMatches(record, row.command))
    return { action: "drop", reason: "command-mismatch" };
  const root = { pid: record.pid, startToken: record.startToken };
  const withTokens = (pids: ReadonlyArray<number>) =>
    pids.flatMap((pid) => {
      const member = context.table.get(pid);
      const startToken = member && (context.startTokenOf ?? rowStartToken)(member);
      return startToken ? [{ pid, startToken }] : [];
    });
  if (record.kill === "group") {
    // A detached child leads its group (PGID == PID); anything else could name other processes.
    if (row.pgid !== record.pid) return { action: "drop", reason: "not-group-leader" };
    const members = [...context.table.values()]
      .filter((entry) => entry.pgid === record.pid && entry.pid !== record.pid)
      .map((entry) => entry.pid);
    return {
      action: "kill",
      targets: { kill: "group", processes: [root, ...withTokens(members)] },
    };
  }
  const descendants = withTokens(descendantsOf(context.table, record.pid));
  return { action: "kill", targets: { kill: "tree", processes: [root, ...descendants] } };
}

const groupLeader = (targets: ProcessLedgerKillTargets) => targets.processes[0]!.pid;

const targetsAlive = (targets: ProcessLedgerKillTargets) =>
  targets.kill === "group"
    ? processGroupAlive(groupLeader(targets))
    : targets.processes.some((target) => processAlive(target.pid));

/** SIGTERM right after the proof: the whole group (members started since the snapshot too). */
const sigtermTargets = (targets: ProcessLedgerKillTargets) => {
  if (targets.kill === "group") {
    signalProcessGroup(groupLeader(targets), "SIGTERM");
    return;
  }
  for (const target of targets.processes) signalProcess(target.pid, "SIGTERM");
};

const waitUntilDead = Effect.fn("ProcessLedger.waitUntilDead")(function* (
  targets: ReadonlyArray<ProcessLedgerKillTargets>,
  within: Duration.Duration,
) {
  const pollMs = Duration.toMillis(REAP_POLL);
  for (let waited = 0; targets.some(targetsAlive) && waited < Duration.toMillis(within); ) {
    yield* Effect.sleep(REAP_POLL);
    waited += pollMs;
  }
});

/**
 * Re-prove survivors against a fresh table before SIGKILL: during the grace period a target may
 * have exited and its PID (or, once its group emptied, its PGID) been reused. Only processes whose
 * start token is unchanged stay, and SIGKILL goes to each of them, never to a PGID. No table, no
 * SIGKILL.
 */
const reproveSurvivors = (
  survivors: ReadonlyArray<ProcessLedgerKillTargets>,
  table: ProcessTable,
  startTokenOf: (row: ProcessTableRow) => string | undefined,
): ReadonlyArray<ProcessLedgerKillTarget> =>
  survivors.flatMap((targets) =>
    targets.processes.filter((target) => {
      const row = table.get(target.pid);
      return row !== undefined && startTokenOf(row) === target.startToken;
    }),
  );

export interface KillProcessLedgerTargetsOptions {
  readonly grace?: Duration.Input;
  readonly readTable?: () => Promise<ProcessTable | undefined>;
  readonly startTokenOf?: (row: ProcessTableRow) => string | undefined;
}

/**
 * SIGTERM every target at once, give them the grace period together, then SIGKILL the survivors
 * that are still provably the same processes. Returns, per target in order, whether it is gone (a
 * survivor keeps its record for the next startup).
 */
export const killProcessLedgerTargets = Effect.fn("ProcessLedger.killTargets")(function* (
  targets: ReadonlyArray<ProcessLedgerKillTargets>,
  options: KillProcessLedgerTargetsOptions = {},
) {
  if (targets.length === 0) return [];
  for (const target of targets) sigtermTargets(target);
  yield* waitUntilDead(
    targets,
    Duration.fromInputUnsafe(options.grace ?? PROCESS_LEDGER_REAP_GRACE),
  );
  const survivors = targets.filter(targetsAlive);
  if (survivors.length > 0) {
    const table = yield* Effect.promise(options.readTable ?? readProcessTable);
    const proven = table
      ? reproveSurvivors(survivors, table, options.startTokenOf ?? rowStartToken)
      : [];
    yield* Effect.logWarning("Orphaned provider processes ignored SIGTERM; sending SIGKILL", {
      pids: proven.map((target) => target.pid),
      survivors: survivors.length,
    });
    for (const target of proven) signalProcess(target.pid, "SIGKILL");
    yield* waitUntilDead(survivors, SIGKILL_EXIT_WAIT);
  }
  return targets.map((target) => !targetsAlive(target));
});
