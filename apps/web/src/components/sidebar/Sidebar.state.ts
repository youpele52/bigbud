import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  BUILT_IN_CHATS_PROJECT_ID,
  isBuiltInChatsProject,
  type ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { isElectron } from "../../config/env";
import { useStore } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import { useSidebarGitStatus } from "../../hooks/useSidebarGitStatus";
import { resolveNewChatOptions, useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useDesktopUpdateState } from "../../hooks/useDesktopUpdateState";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useServerProviders } from "../../rpc/serverState";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import {
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  orderItemsByPreferredIds,
} from "./Sidebar.logic";
import {
  getArm64IntelBuildWarningDescription,
  shouldShowArm64IntelBuildWarning,
} from "../layout/desktopUpdate.logic";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";
import { useSidebarProjectAddActions } from "./Sidebar.projectAddActions";
import { useSidebarProjectActions } from "./Sidebar.projectActions";
import { useSidebarRemoteThreadActivation } from "./Sidebar.remoteThreadActivation";
import { buildSidebarProjectSnapshots } from "./Sidebar.state.projectSnapshots";
import { buildSharedProjectItemProps } from "./Sidebar.state.sharedProjectItemProps";
import { useSidebarThreadActions } from "./Sidebar.threadActions";
import { useSidebarRenderedProjects } from "./Sidebar.renderedProjects";
import { registerSidebarAddProjectHandlers } from "./SidebarAddProjectBridge";
import { buildSidebarStateResult } from "./Sidebar.state.result";
import { useSidebarRecentSections } from "./Sidebar.state.sections";
import { useAutomationThreadIds } from "../automation/useAutomationThreadIds";
import type { SharedProjectItemProps, SidebarProjectSnapshot, SidebarState } from "./Sidebar.types";

export function useSidebarState(): SidebarState {
  const projects = useStore((store) => store.projects);
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const { favouritesExpanded, projectExpandedById, projectOrder, setFavouritesExpanded } =
    useUiStateStore(
      useShallow((store) => ({
        favouritesExpanded: store.favouritesExpanded,
        projectExpandedById: store.projectExpandedById,
        projectOrder: store.projectOrder,
        setFavouritesExpanded: store.setFavouritesExpanded,
      })),
    );
  const verifiedExecutionTargetIds = useRemoteAccessStore(
    (store) => store.verifiedExecutionTargetIds,
  );

  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const appSettings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const platform = navigator.platform;

  const {
    activeDraftThread,
    activeThread: activeThreadFull,
    chatsProjectId,
    handleNewThread,
  } = useHandleNewThread();

  const activeThread = useMemo(
    () =>
      activeThreadFull
        ? {
            projectId: activeThreadFull.projectId,
            branch: activeThreadFull.branch,
            worktreePath: activeThreadFull.worktreePath,
          }
        : null,
    [activeThreadFull],
  );

  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });

  const {
    desktopUpdateState,
    desktopUpdateButtonDisabled,
    desktopUpdateButtonAction,
    handleDesktopUpdateButtonClick,
  } = useDesktopUpdateState();

  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects.filter((project) => !isBuiltInChatsProject(project.id)),
        preferredIds: projectOrder,
        getId: (project) => project.id,
      }),
    [projectOrder, projects],
  );

  const chatsProject = useMemo(
    () => projects.find((project) => isBuiltInChatsProject(project.id)) ?? null,
    [projects],
  );

  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(
    () =>
      buildSidebarProjectSnapshots({
        orderedProjects,
        projectExpandedById,
        verifiedExecutionTargetIds,
      }),
    [orderedProjects, projectExpandedById, verifiedExecutionTargetIds],
  );

  const sidebarThreads = useMemo(() => Object.values(sidebarThreadsById), [sidebarThreadsById]);

  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const projectExecutionTargetIdById = useMemo(
    () =>
      new Map(
        projects.map(
          (project) => [project.id, resolveWorkspaceExecutionTargetId(project)] as const,
        ),
      ),
    [projects],
  );

  const threadGitTargets = useMemo(
    () =>
      sidebarThreads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
        executionTargetId:
          thread.workspaceExecutionTargetId !== undefined || thread.executionTargetId !== undefined
            ? resolveWorkspaceExecutionTargetId(thread)
            : projectExecutionTargetIdById.get(thread.projectId),
      })),
    [projectCwdById, projectExecutionTargetIdById, sidebarThreads],
  );
  const prByThreadId = useSidebarGitStatus(threadGitTargets);

  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);

  const visibleThreads = useMemo(
    () =>
      sidebarThreads.filter((thread) => thread.archivedAt === null && thread.deletingAt === null),
    [sidebarThreads],
  );
  const visibleChatThreads = useMemo(
    () => visibleThreads.filter((thread) => isBuiltInChatsProject(thread.projectId)),
    [visibleThreads],
  );
  const sortedProjects = useMemo(
    () =>
      sortProjectsForSidebar(sidebarProjects, visibleThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, sidebarProjects, visibleThreads],
  );
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";

  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  const navigateToThreadRoute = useCallback(
    (threadId: ThreadId) => {
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate],
  );

  const handleNewChat = useCallback(() => {
    const projectId = chatsProjectId ?? BUILT_IN_CHATS_PROJECT_ID;
    return handleNewThread(projectId, resolveNewChatOptions());
  }, [chatsProjectId, handleNewThread]);

  const remoteThreadActivation = useSidebarRemoteThreadActivation({
    sidebarThreadsById,
    projectCwdById,
    navigateToThreadRoute,
  });
  const { navigateToThread: navigateToVerifiedThread } = remoteThreadActivation;

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = sortThreadsForSidebar(
        (threadIdsByProjectId[projectId as string] ?? [])
          .map((threadId) => sidebarThreadsById[threadId as string])
          .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
          .filter((thread) => thread.archivedAt === null && thread.deletingAt === null),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;
      navigateToVerifiedThread(latestThread.id);
    },
    [
      appSettings.sidebarThreadSortOrder,
      navigateToVerifiedThread,
      sidebarThreadsById,
      threadIdsByProjectId,
    ],
  );

  const cancelProjectRenameRef = useRef<(() => void) | null>(null);
  const cancelThreadRenameRef = useRef<(() => void) | null>(null);

  const forwardCancelProjectRename = useCallback(() => {
    cancelProjectRenameRef.current?.();
  }, []);

  const forwardCancelThreadRename = useCallback(() => {
    cancelThreadRenameRef.current?.();
  }, []);

  const threadActions = useSidebarThreadActions({
    sidebarThreadsById,
    projectCwdById,
    appSettings,
    navigateToThreadRoute: remoteThreadActivation.navigateToThread,
    cancelProjectRename: forwardCancelProjectRename,
  });

  const projectAddActions = useSidebarProjectAddActions({
    projects,
    focusMostRecentThreadForProject,
    handleNewThread,
    defaultThreadEnvMode: appSettings.defaultThreadEnvMode,
    serverProviders,
  });

  const projectActions = useSidebarProjectActions({
    projects,
    threadIdsByProjectId,
    sidebarProjects,
    appSettings,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    selectedThreadIdsSize: threadActions.selectedThreadIds.size,
    clearSelection: threadActions.clearSelection,
    copyPathToClipboard,
    cancelThreadRename: forwardCancelThreadRename,
  });

  useEffect(
    () =>
      registerSidebarAddProjectHandlers({
        handleStartAddProject: projectAddActions.handleStartAddProject,
        isFlowVisible: () => projectAddActions.shouldShowProjectPathEntry,
      }),
    [projectAddActions.handleStartAddProject, projectAddActions.shouldShowProjectPathEntry],
  );

  cancelProjectRenameRef.current = projectActions.cancelProjectRename;
  cancelThreadRenameRef.current = threadActions.cancelRename;

  const [areChatsExpanded, setAreChatsExpanded] = useState(true);
  const [showAllChats, setShowAllChats] = useState(false);

  const { favoriteThreadIds, renderedFavorites, renderedChats, visibleChatThreadIdsForJumpHints } =
    useSidebarRecentSections({
      favoriteThreadIds: appSettings.favoriteThreadIds,
      sidebarThreadsById,
      visibleChatThreads,
      sidebarChatsSortOrder: appSettings.sidebarChatsSortOrder,
      areChatsExpanded,
      showAllChats,
    });

  // ── Rendered projects + jump hints + keyboard nav sub-hook ────────────────
  const renderedProjectsState = useSidebarRenderedProjects({
    sortedProjects,
    visibleChatThreadIds: visibleChatThreadIdsForJumpHints,
    routeThreadId,
    navigateToThread: threadActions.navigateToThread,
    platform,
  });

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (threadActions.selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      threadActions.clearSelection();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [threadActions]);

  const automationThreadIds = useAutomationThreadIds();

  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;

  const sharedProjectItemProps = useMemo(
    (): SharedProjectItemProps =>
      buildSharedProjectItemProps({
        isManualProjectSorting,
        newThreadShortcutLabel: renderedProjectsState.newThreadShortcutLabel,
        showThreadJumpHints: renderedProjectsState.showThreadJumpHints,
        threadJumpLabelById: renderedProjectsState.threadJumpLabelById,
        appSettingsDefaultThreadEnvMode: appSettings.defaultThreadEnvMode,
        routeThreadId,
        threadActions,
        activeThread,
        activeDraftThread,
        projectActions,
        favoriteThreadIds,
        automationThreadIds,
        prByThreadId,
        handleNewThread,
        renderedProjectsState,
      }),
    [
      isManualProjectSorting,
      renderedProjectsState,
      appSettings.defaultThreadEnvMode,
      routeThreadId,
      threadActions,
      activeThread,
      activeDraftThread,
      projectActions,
      favoriteThreadIds,
      automationThreadIds,
      prByThreadId,
      handleNewThread,
    ],
  );

  return buildSidebarStateResult({
    projects,
    bootstrapComplete,
    chatsProject,
    renderedFavorites,
    favouritesExpanded,
    setFavouritesExpanded,
    areChatsExpanded,
    setAreChatsExpanded,
    showAllChats,
    setShowAllChats,
    renderedChats,
    renderedProjectsState,
    isManualProjectSorting,
    isOnSettings,
    pathname,
    prByThreadId,
    appSettings,
    desktopUpdateState,
    desktopUpdateButtonDisabled,
    desktopUpdateButtonAction,
    handleDesktopUpdateButtonClick,
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    projectAddActions,
    projectActions,
    threadActions,
    handleNewChat,
    handleNewThread,
    sharedProjectItemProps,
    updateSettings,
  });
}
