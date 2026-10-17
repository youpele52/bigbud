import type { SidebarThreadSummary, Thread } from "../../models/types";
import { isVisibleThread } from "../../logic/thread/threadVisibility.logic";

export interface ThreadNavigationState {
  readonly threads: readonly Thread[];
  readonly sidebarThreadsById: Readonly<Record<string, SidebarThreadSummary | undefined>>;
}

export function parseOpenThreadAction(action: unknown): string | null {
  if (typeof action !== "string" || !action.startsWith("open-thread:")) {
    return null;
  }

  const threadId = action.slice("open-thread:".length).trim();
  return threadId.length > 0 ? threadId : null;
}

export function isThreadNavigationAvailable(
  threadId: string,
  state: ThreadNavigationState,
): boolean {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (thread) {
    return isVisibleThread(thread) && thread.deletingAt == null;
  }

  const summary = state.sidebarThreadsById[threadId];
  return summary !== undefined && summary.deletingAt == null;
}
