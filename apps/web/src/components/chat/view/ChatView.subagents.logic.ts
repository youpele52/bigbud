import type { Thread } from "../../../models/types";
import type { TurnId } from "@bigbud/contracts/core/baseSchemas";

/** Background Stop is control authority, not a claim that the root turn is running. */
export function hasOwnedV2DescendantWork(
  thread: Pick<Thread, "session" | "providerAgents"> | undefined,
): boolean {
  return (
    thread?.session?.provider === "opencodeV2" &&
    Boolean(
      thread.session.retainedFamily ||
      thread.providerAgents?.some(
        (task) =>
          task.kind === "providerSubagent" &&
          /^bbv2-owned:[a-f0-9]{64}$/.test(task.id) &&
          !["completed", "failed", "stopped", "cancelled"].includes(task.status),
      ),
    )
  );
}

/**
 * Running provider subagents that outlive (or may outlive) the root turn, on any provider:
 * those marked background, plus any still actively running while the root turn is idle (for
 * example Codex children). Thread Stop stops them too, so the composer asks first and keeps
 * Stop available while the root turn is idle.
 */
export function countRunningBackgroundSubagents(
  thread: Pick<Thread, "session" | "providerAgents"> | undefined,
): number {
  const rootIdle = thread?.session?.activeTurnId == null;
  return (
    thread?.providerAgents?.filter(
      (task) =>
        task.kind === "providerSubagent" &&
        (task.status === "pending" || task.status === "inProgress") &&
        (task.background === true || (rootIdle && task.activityFresh === true)),
    ).length ?? 0
  );
}

/** Work that keeps thread Stop meaningful after the root turn has finished. */
export function describeThreadBackgroundWork(
  thread: Pick<Thread, "session" | "providerAgents"> | undefined,
) {
  const backgroundSubagentCount = countRunningBackgroundSubagents(thread);
  return {
    backgroundSubagentCount,
    hasBackgroundWork: hasOwnedV2DescendantWork(thread) || backgroundSubagentCount > 0,
  };
}

/** Idle Stop targets the session's background work, never an already-completed root turn. */
export function getThreadInterruptTurnId(
  thread: Pick<Thread, "session" | "providerAgents"> & {
    readonly latestTurn?: { readonly turnId?: TurnId | undefined } | null | undefined;
  },
) {
  return (
    thread.session?.activeTurnId ??
    (describeThreadBackgroundWork(thread).hasBackgroundWork ? undefined : thread.latestTurn?.turnId)
  );
}
