import type { useDesktopUpdateState } from "../../hooks/useDesktopUpdateState";
import type { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import type { Project } from "../../models/types";
import type { ThreadId } from "@bigbud/contracts";
import type { ThreadPr } from "./SidebarThreadRow";
import type { SidebarProjectAddActionsOutput } from "./Sidebar.projectAddActions";
import type { SidebarProjectActionsOutput } from "./Sidebar.projectActions";
import type { SidebarRenderedProjectsOutput } from "./Sidebar.renderedProjects";
import type { SidebarThreadActionsOutput } from "./Sidebar.threadActions.types";
import type {
  SharedProjectItemProps,
  SidebarRenderedThreadEntry,
  SidebarState,
} from "./Sidebar.types";

export interface BuildSidebarStateResultInput {
  projects: Project[];
  bootstrapComplete: boolean;
  chatsProject: Project | null;
  renderedFavorites: SidebarRenderedThreadEntry[];
  favouritesExpanded: boolean;
  setFavouritesExpanded: (expanded: boolean) => void;
  showAllFavourites: boolean;
  setShowAllFavourites: (showAll: boolean) => void;
  areChatsExpanded: boolean;
  setAreChatsExpanded: (expanded: boolean) => void;
  showAllChats: boolean;
  setShowAllChats: (showAll: boolean) => void;
  renderedChats: SidebarRenderedThreadEntry[];
  renderedProjectsState: SidebarRenderedProjectsOutput;
  isManualProjectSorting: boolean;
  isOnSettings: boolean;
  pathname: string;
  prByThreadId: Map<ThreadId, ThreadPr>;
  appSettings: ReturnType<typeof useSettings>;
  desktopUpdateState: ReturnType<typeof useDesktopUpdateState>["desktopUpdateState"];
  desktopUpdateButtonDisabled: boolean;
  desktopUpdateButtonAction: ReturnType<typeof useDesktopUpdateState>["desktopUpdateButtonAction"];
  handleDesktopUpdateButtonClick: () => void;
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  projectAddActions: SidebarProjectAddActionsOutput;
  projectActions: SidebarProjectActionsOutput;
  threadActions: SidebarThreadActionsOutput;
  handleNewChat: () => Promise<void>;
  handleNewThread: SharedProjectItemProps["handleNewThread"];
  sharedProjectItemProps: SharedProjectItemProps;
  updateSettings: ReturnType<typeof useUpdateSettings>["updateSettings"];
}

export function buildSidebarStateResult(input: BuildSidebarStateResultInput): SidebarState {
  return {
    projects: input.projects,
    bootstrapComplete: input.bootstrapComplete,
    chatsProject: input.chatsProject,
    renderedFavorites: input.renderedFavorites,
    areFavouritesExpanded: input.favouritesExpanded,
    setAreFavouritesExpanded: input.setFavouritesExpanded,
    showAllFavourites: input.showAllFavourites,
    setShowAllFavourites: input.setShowAllFavourites,
    areChatsExpanded: input.areChatsExpanded,
    setAreChatsExpanded: input.setAreChatsExpanded,
    showAllChats: input.showAllChats,
    setShowAllChats: input.setShowAllChats,
    renderedChats: input.renderedChats,
    renderedProjects: input.renderedProjectsState.renderedProjects,
    isManualProjectSorting: input.isManualProjectSorting,
    isOnSettings: input.isOnSettings,
    pathname: input.pathname,
    prByThreadId: input.prByThreadId,
    appSettings: input.appSettings,
    desktopUpdateState: input.desktopUpdateState,
    desktopUpdateButtonDisabled: input.desktopUpdateButtonDisabled,
    desktopUpdateButtonAction: input.desktopUpdateButtonAction,
    handleDesktopUpdateButtonClick: input.handleDesktopUpdateButtonClick,
    showArm64IntelBuildWarning: input.showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription: input.arm64IntelBuildWarningDescription,
    ...input.projectAddActions,
    ...input.projectActions,
    ...input.threadActions,
    handleNewChat: input.handleNewChat,
    handleNewThread: input.handleNewThread,
    expandThreadListForProject: input.renderedProjectsState.expandThreadListForProject,
    collapseThreadListForProject: input.renderedProjectsState.collapseThreadListForProject,
    attachThreadListAutoAnimateRef: input.renderedProjectsState.attachThreadListAutoAnimateRef,
    sharedProjectItemProps: input.sharedProjectItemProps,
    updateSettings: input.updateSettings,
    newThreadShortcutLabel: input.renderedProjectsState.newThreadShortcutLabel,
    showThreadJumpHints: input.renderedProjectsState.showThreadJumpHints,
    threadJumpLabelById: input.renderedProjectsState.threadJumpLabelById,
  };
}
