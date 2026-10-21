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

/** Idle family Stop targets the owned session, never an already-completed root turn. */
export function getThreadInterruptTurnId(
  thread: Pick<Thread, "session" | "providerAgents"> & {
    readonly latestTurn?: { readonly turnId?: TurnId | undefined } | null | undefined;
  },
) {
  return (
    thread.session?.activeTurnId ??
    (hasOwnedV2DescendantWork(thread) ? undefined : thread.latestTurn?.turnId)
  );
}
