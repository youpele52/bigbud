import type { ThreadId } from "@bigbud/contracts";

import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { clearPromotedDraftThreads, useComposerDraftStore } from "../stores/composer";
import { useStore } from "../stores/main";
import type { SyncProjectInput, SyncThreadInput } from "../stores/ui";
import { reconcileSideChatSnapshot } from "../components/chat/side-chat/sideChat.actions";

export function reconcileSnapshotDerivedState(input: {
  readonly syncProjects: (projects: readonly SyncProjectInput[]) => void;
  readonly syncThreads: (threads: readonly SyncThreadInput[]) => void;
  readonly removeOrphanedTerminalStates: (activeThreadIds: Set<ThreadId>) => void;
}): void {
  const threads = useStore.getState().threads;
  reconcileSideChatSnapshot(threads);
  const projects = useStore.getState().projects;
  input.syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
  input.syncThreads(
    threads.map((thread) => ({
      id: thread.id,
      seedVisitedAt: thread.updatedAt ?? thread.createdAt,
    })),
  );
  clearPromotedDraftThreads(threads.map((thread) => thread.id));
  const draftThreadIds = Object.keys(
    useComposerDraftStore.getState().draftThreadsByThreadId,
  ) as ThreadId[];
  const activeThreadIds = collectActiveTerminalThreadIds({
    snapshotThreads: threads.map((thread) => ({
      id: thread.id,
      deletedAt: null,
      archivedAt: thread.archivedAt,
    })),
    draftThreadIds,
  });
  input.removeOrphanedTerminalStates(activeThreadIds);
}
