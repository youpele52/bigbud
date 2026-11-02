import type { ThreadId } from "@bigbud/contracts";
import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";

import { dispatchCommandWithOutcomeRecovery } from "../../lib/orchestrationCommandRecovery";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../rpc/nativeApi";
import { useStore } from "../../stores/main";
import { toastManager } from "../ui/toast";
import { INYOSIRA_STATE_LABELS } from "./Sidebar.inyosira.logic";

/** Snooze presets offered in Move to; "Snooze for…" opens the custom duration picker. */
export const INYOSIRA_SNOOZE_PRESETS: ReadonlyArray<{
  readonly minutes: number;
  readonly label: string;
}> = [
  { minutes: 2, label: "2 minutes" },
  { minutes: 10, label: "10 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 4 * 60, label: "4 hours" },
  { minutes: 24 * 60, label: "24 hours" },
];

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "An error occurred.";

/**
 * Moves threads to a state, one command per thread, each fenced by the revision this client saw.
 * Moving never stops, archives, or answers anything. Reports partial failure instead of hiding it.
 */
export async function moveThreadsToState(
  threadIds: readonly ThreadId[],
  state: ThreadOrganizationState,
): Promise<void> {
  const api = readNativeApi();
  if (!api || threadIds.length === 0) return;
  const summaries = useStore.getState().sidebarThreadsById;
  const results = await Promise.allSettled(
    threadIds.map((threadId) => {
      const revision = summaries[threadId]?.organization?.revision;
      return dispatchCommandWithOutcomeRecovery(api, {
        type: "thread.organization.move",
        commandId: newCommandId(),
        threadId,
        state,
        ...(revision !== undefined ? { expectedRevision: revision } : {}),
        createdAt: new Date().toISOString(),
      });
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length === 0) return;
  toastManager.add({
    type: "error",
    title:
      threadIds.length === 1
        ? `Couldn't move thread to ${INYOSIRA_STATE_LABELS[state]}`
        : `Couldn't move ${failures.length} of ${threadIds.length} threads to ${INYOSIRA_STATE_LABELS[state]}`,
    description: errorMessage(failures[0]?.reason),
  });
}

/** Puts a thread in Later until the server-calculated deadline. */
export async function snoozeThread(threadId: ThreadId, durationMinutes: number): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  try {
    await dispatchCommandWithOutcomeRecovery(api, {
      type: "thread.organization.snooze",
      commandId: newCommandId(),
      threadId,
      durationMinutes,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn't snooze thread",
      description: errorMessage(error),
    });
  }
}
