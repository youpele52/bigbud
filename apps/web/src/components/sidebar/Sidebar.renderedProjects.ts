import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ProjectId, type ThreadId } from "@bigbud/contracts";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { useTerminalStateStore } from "../../stores/terminal";
import { selectThreadTerminalState } from "../../stores/terminal";
import { useServerKeybindings } from "../../rpc/serverState";
import { shortcutLabelForCommand, threadJumpCommandForIndex } from "../../models/keybindings";
import { useSettings } from "../../hooks/useSettings";
import { readNativeApi } from "../../rpc/nativeApi";
import { loadMoreProjectThreadSummaries } from "../../routes/-__root.bounded-bootstrap";
import {
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  resolveProjectStatusIndicator,
  resolveThreadStatusPill,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import { useSidebarKeyboardNav } from "./Sidebar.keyboardNav.logic";
import type { SidebarThreadSummary } from "../../models/types";
import type { RenderedProjectEntry, SidebarProjectSnapshot } from "./Sidebar.types";

const THREAD_PREVIEW_LIMIT = 4;

export interface SidebarRenderedProjectsInput {
  sortedProjects: SidebarProjectSnapshot[];
  visibleChatThreadIds: readonly ThreadId[];
  routeThreadId: ThreadId | null;
  navigateToThread: (threadId: ThreadId) => void;
  platform: string;
}

export interface SidebarRenderedProjectsOutput {
  renderedProjects: RenderedProjectEntry[];
  expandedThreadListsByProject: ReadonlySet<ProjectId>;
  expandThreadListForProject: (projectId: ProjectId) => void;
  collapseThreadListForProject: (projectId: ProjectId) => void;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  showThreadJumpHints: boolean;
  threadJumpLabelById: Map<ThreadId, string>;
  newThreadShortcutLabel: string | null | undefined;
  loadMoreThreadsForProject: (projectId: ProjectId) => void;
}

/** Encapsulates rendered-projects derivation, expand/collapse state, jump hints, and keyboard nav. */
export function useSidebarRenderedProjects({
  sortedProjects,
  visibleChatThreadIds,
  routeThreadId,
  navigateToThread,
  platform,
}: SidebarRenderedProjectsInput): SidebarRenderedProjectsOutput {
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const threadSummaryCursorByProjectId = useStore(
    (store) => store.threadSummaryCursorByProjectId ?? {},
  );
  const { threadLastVisitedAtById } = useUiStateStore(
    useShallow((store) => ({
      threadLastVisitedAtById: store.threadLastVisitedAtById,
    })),
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const keybindings = useServerKeybindings();
  const appSettings = useSettings();

  const routeTerminalOpen = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId).terminalOpen
    : false;

  const sidebarShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: routeTerminalOpen,
      },
    }),
    [platform, routeTerminalOpen],
  );

  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const [loadingThreadPagesByProject, setLoadingThreadPagesByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());

  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();

  const renderedProjects = useMemo(
    () =>
      sortedProjects.map((project) => {
        const resolveProjectThreadStatus = (thread: SidebarThreadSummary) =>
          resolveThreadStatusPill({
            thread: {
              ...thread,
              lastVisitedAt: threadLastVisitedAtById[thread.id as string],
            },
          });
        const projectThreads = sortThreadsForSidebar(
          (threadIdsByProjectId[project.id as string] ?? [])
            .map((threadId) => sidebarThreadsById[threadId])
            .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
            .filter((thread) => thread.archivedAt === null && thread.deletingAt === null),
          appSettings.sidebarThreadSortOrder,
        );
        const projectStatus = resolveProjectStatusIndicator(
          projectThreads.map((thread) => resolveProjectThreadStatus(thread)),
        );
        const activeThreadId = routeThreadId ?? undefined;
        const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
        const shouldShowThreadPanel = project.expanded;
        const {
          hasHiddenThreads,
          hiddenThreads,
          visibleThreads: visibleProjectThreads,
        } = getVisibleThreadsForProject({
          threads: projectThreads,
          activeThreadId,
          isThreadListExpanded,
          previewLimit: THREAD_PREVIEW_LIMIT,
        });
        const hiddenThreadStatus = resolveProjectStatusIndicator(
          hiddenThreads.map((thread) => resolveProjectThreadStatus(thread)),
        );
        const hasMoreThreads = threadSummaryCursorByProjectId[project.id] !== null;
        const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);
        const renderedThreadIds = visibleProjectThreads.map((thread) => thread.id);
        const showEmptyThreadState =
          project.expanded &&
          projectThreads.length === 0 &&
          Object.hasOwn(threadSummaryCursorByProjectId, project.id);

        return {
          hasHiddenThreads,
          hasMoreThreads,
          hiddenThreadStatus,
          orderedProjectThreadIds,
          project,
          projectStatus,
          renderedThreadIds,
          showEmptyThreadState,
          shouldShowThreadPanel,
          isThreadListExpanded,
          isLoadingMoreThreads: loadingThreadPagesByProject.has(project.id),
        };
      }),
    [
      appSettings.sidebarThreadSortOrder,
      expandedThreadListsByProject,
      routeThreadId,
      sortedProjects,
      sidebarThreadsById,
      threadSummaryCursorByProjectId,
      threadIdsByProjectId,
      threadLastVisitedAtById,
      loadingThreadPagesByProject,
    ],
  );

  const visibleSidebarThreadIds = useMemo(
    () => [...visibleChatThreadIds, ...getVisibleSidebarThreadIds(renderedProjects)],
    [renderedProjects, visibleChatThreadIds],
  );

  const threadJumpCommandById = useMemo(() => {
    const mapping = new Map<ThreadId, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleSidebarThreadIds.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadId, jumpCommand);
    }
    return mapping;
  }, [visibleSidebarThreadIds]);

  const threadJumpThreadIds = useMemo(
    () => [...threadJumpCommandById.keys()],
    [threadJumpCommandById],
  );

  const threadJumpLabelById = useMemo(() => {
    const mapping = new Map<ThreadId, string>();
    for (const [threadId, command] of threadJumpCommandById) {
      const label = shortcutLabelForCommand(keybindings, command, sidebarShortcutLabelOptions);
      if (label) {
        mapping.set(threadId, label);
      }
    }
    return mapping;
  }, [keybindings, sidebarShortcutLabelOptions, threadJumpCommandById]);

  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", sidebarShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", sidebarShortcutLabelOptions);

  const orderedSidebarThreadIds = visibleSidebarThreadIds;

  useSidebarKeyboardNav({
    keybindings,
    platform,
    routeTerminalOpen,
    routeThreadId,
    orderedSidebarThreadIds,
    threadJumpThreadIds,
    navigateToThread,
    updateThreadJumpHintsVisibility,
  });

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  const loadMoreThreadsForProject = useCallback(
    (projectId: ProjectId) => {
      const api = readNativeApi();
      if (!api || loadingThreadPagesByProject.has(projectId)) {
        return;
      }
      setLoadingThreadPagesByProject((current) => new Set(current).add(projectId));
      void loadMoreProjectThreadSummaries({ api, projectId }).finally(() => {
        setLoadingThreadPagesByProject((current) => {
          const next = new Set(current);
          next.delete(projectId);
          return next;
        });
      });
    },
    [loadingThreadPagesByProject],
  );

  useEffect(() => {
    for (const project of sortedProjects) {
      if (
        project.expanded &&
        !Object.hasOwn(threadSummaryCursorByProjectId, project.id) &&
        !loadingThreadPagesByProject.has(project.id)
      ) {
        loadMoreThreadsForProject(project.id);
      }
    }
  }, [
    loadMoreThreadsForProject,
    loadingThreadPagesByProject,
    sortedProjects,
    threadSummaryCursorByProjectId,
  ]);

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    animatedThreadListsRef.current.add(node);
  }, []);

  return {
    renderedProjects,
    expandedThreadListsByProject,
    expandThreadListForProject,
    collapseThreadListForProject,
    attachThreadListAutoAnimateRef,
    showThreadJumpHints,
    threadJumpLabelById,
    newThreadShortcutLabel,
    loadMoreThreadsForProject,
  };
}
