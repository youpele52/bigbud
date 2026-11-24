import type { ProjectId, ThreadId } from "@bigbud/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useStore } from "../../stores/main";
import { selectThreadSurfacePanes, useTerminalStateStore } from "../../stores/terminal";
import { useTerminalLivenessStore } from "../../stores/terminal/terminalLiveness.store";
import { INYOSIRA_STATE_LABELS, organizationStateOf } from "./Sidebar.inyosira.logic";
import type { ProjectTerminalThread } from "./SidebarProjectTerminals.logic";

/**
 * Whose terminals a list shows: one project's threads, an explicit thread list, every thread
 * except a list, or nothing (a hook that must still be called).
 */
export type TerminalListScope =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "threads"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly kind: "excluding"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly kind: "none" };

function inScope(
  scope: TerminalListScope,
  listed: ReadonlySet<string> | null,
  threadId: string,
  projectId: ProjectId,
): boolean {
  switch (scope.kind) {
    case "project":
      return projectId === scope.projectId;
    case "threads":
      return listed!.has(threadId);
    case "excluding":
      return !listed!.has(threadId);
    case "none":
      return false;
  }
}

const PANE_KEY_SEPARATOR = "\u0000";

/**
 * The scope's threads that have live terminals, with their liveness and panes. Every selector
 * returns primitives or store-stable objects, so unrelated thread or terminal updates do not
 * re-render the header.
 */
export function useTerminalThreads(scope: TerminalListScope): ProjectTerminalThread[] {
  const liveThreadIds = useTerminalLivenessStore(
    useShallow((state) => Object.keys(state.byThreadId)),
  );
  const listed =
    scope.kind === "threads" || scope.kind === "excluding"
      ? new Set<string>(scope.threadIds)
      : null;
  const threadIds = useStore(
    useShallow((state) =>
      liveThreadIds.filter((threadId) => {
        const thread = state.sidebarThreadsById[threadId as ThreadId];
        if (thread === undefined || thread.archivedAt !== null || thread.deletingAt) return false;
        return inScope(scope, listed, threadId, thread.projectId);
      }),
    ),
  ) as ThreadId[];
  const titles = useStore(
    useShallow((state) => threadIds.map((id) => state.sidebarThreadsById[id]?.title ?? "")),
  );
  const groups = useStore(
    useShallow((state) =>
      threadIds.map((id) => {
        const summary = state.sidebarThreadsById[id];
        return summary ? INYOSIRA_STATE_LABELS[organizationStateOf(summary)] : "";
      }),
    ),
  );
  const liveness = useTerminalLivenessStore(
    useShallow((state) => threadIds.map((id) => state.byThreadId[id])),
  );
  const paneKeys = useTerminalStateStore(
    useShallow((state) =>
      threadIds.flatMap((id) =>
        selectThreadSurfacePanes(state, id).map((pane) => `${id}${PANE_KEY_SEPARATOR}${pane}`),
      ),
    ),
  );

  return useMemo(() => {
    const panesByThread = new Map<string, string[]>();
    for (const key of paneKeys) {
      const [threadId, pane] = key.split(PANE_KEY_SEPARATOR) as [string, string];
      const panes = panesByThread.get(threadId) ?? [];
      panes.push(pane);
      panesByThread.set(threadId, panes);
    }
    return threadIds.map((threadId, index) => ({
      threadId,
      title: titles[index] ?? "",
      group: groups[index] ?? "",
      liveness: liveness[index],
      panes: panesByThread.get(threadId) ?? [],
    }));
  }, [threadIds, titles, groups, liveness, paneKeys]);
}
