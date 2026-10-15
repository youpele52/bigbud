import { deriveThreadModelChoice } from "../../logic/session/session.activity.modelChoice.logic";
import type { DelegatedChildSummary, Thread } from "../../models/types";

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

/** The tributary's own record wins; otherwise the linked summary already on the item stays. */
function modelChoice(item: DelegatedChildSummary, child: Thread) {
  const record = child.activities ? deriveThreadModelChoice(child.activities) : null;
  if (record === null)
    return item.modelChoice === undefined ? {} : { modelChoice: item.modelChoice };
  return { modelChoice: { source: "tributary" as const, record } };
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
              ...modelChoice(item, child),
            }
          : item,
      ),
    };
  });
  return changed ? next : threads;
}
