/**
 * Thread Stop treats every provider subagent as foreground, background ones included: once the
 * stopped turn has settled, any subagent row the provider still reports as running is marked
 * stopped, so the card matches what the user asked for on every provider.
 *
 * @module SubagentStopSweep.logic
 */
import type { OrchestrationTask } from "@bigbud/contracts";

/** Shown as the row's Reason when bigbud, not the provider, settled it. */
export const SUBAGENT_STOPPED_WITH_THREAD_REASON = "Stopped with the thread";

const isRunning = (task: OrchestrationTask) =>
  task.status === "pending" || task.status === "inProgress";

/**
 * Running provider subagents that already existed when Stop was requested. Subagents created
 * later belong to a newer turn (for example interrupt-and-continue) and are left alone.
 */
export function selectRunningSubagents(
  tasks: ReadonlyArray<OrchestrationTask>,
  requestedAt: string,
): ReadonlyArray<OrchestrationTask> {
  return tasks.filter(
    (task) => task.kind === "providerSubagent" && isRunning(task) && task.createdAt <= requestedAt,
  );
}

/** Targets that are still running in the current tasks; provider-settled ones drop out. */
export function stillRunningTargets(
  tasks: ReadonlyArray<OrchestrationTask>,
  targetIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationTask> {
  return tasks.filter((task) => targetIds.has(task.id) && isRunning(task));
}

/**
 * The stopped snapshot for a still-running subagent. Freshness advances by one observation in
 * the same epoch, so older in-flight updates cannot revive the row, while a genuinely newer
 * provider update (later revision or timestamp) still can.
 */
export function buildStoppedSubagentSnapshot(
  task: OrchestrationTask,
  stoppedAt: string,
): OrchestrationTask {
  return {
    ...task,
    status: "stopped",
    activityFresh: false,
    endedAt: task.endedAt ?? stoppedAt,
    terminalReason: task.terminalReason ?? SUBAGENT_STOPPED_WITH_THREAD_REASON,
    freshness: { ...task.freshness, observedOrdinal: task.freshness.observedOrdinal + 1 },
    updatedAt: stoppedAt,
  };
}
