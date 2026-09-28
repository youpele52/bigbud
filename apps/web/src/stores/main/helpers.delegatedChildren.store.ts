import type { Thread } from "../../models/types";

function workflowState(thread: Thread) {
  if (thread.session?.orchestrationStatus === "error" || thread.latestTurn?.state === "error") {
    return "failed" as const;
  }
  if (
    thread.session?.orchestrationStatus === "running" ||
    thread.session?.orchestrationStatus === "starting" ||
    thread.latestTurn?.state === "running"
  ) {
    return "working" as const;
  }
  return "idle" as const;
}

/** Refresh hydrated parent summaries whenever a loaded delegated child changes. */
export function syncDelegatedChildSummaries(threads: Thread[], child: Thread): Thread[] {
  let changed = false;
  const next = threads.map((thread) => {
    if (!thread.delegatedChildren?.some((item) => item.threadId === child.id)) return thread;
    changed = true;
    return {
      ...thread,
      delegatedChildren: thread.delegatedChildren.map((item) =>
        item.threadId === child.id
          ? {
              ...item,
              title: child.title,
              projectId: child.projectId,
              workflowState: workflowState(child),
              updatedAt: child.updatedAt ?? child.session?.updatedAt ?? item.updatedAt,
            }
          : item,
      ),
    };
  });
  return changed ? next : threads;
}
