import { type ProjectId, type ThreadId } from "@bigbud/contracts";
import type { SidebarActionId } from "../../components/sidebar/Sidebar.actions.logic";

export interface PersistedUiState {
  sidebarActionOrder?: string[];
  hiddenSidebarActions?: string[];
  chatsExpanded?: boolean;
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  favouritesExpanded?: boolean;
  lastActiveThreadId?: string;
  projectOrderCwds?: string[];
  projectsExpanded?: boolean;
  remoteProjectsExpanded?: boolean;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
  threadLastVisitedAtById?: Record<string, string>;
}

export interface UiSidebarState {
  sidebarActionOrder: SidebarActionId[];
  hiddenSidebarActions: SidebarActionId[];
  chatsExpanded: boolean;
  favouritesExpanded: boolean;
  projectsExpanded: boolean;
  remoteProjectsExpanded: boolean;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: ProjectId[];
  selectedProjectId: ProjectId | null;
}

export interface UiThreadState {
  lastActiveThreadId: ThreadId | null;
  threadLastVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiState extends UiProjectState, UiSidebarState, UiThreadState {}

export interface SyncProjectInput {
  id: ProjectId;
  cwd: string | null;
}

export interface SyncThreadInput {
  id: ThreadId;
  seedVisitedAt?: string | undefined;
}

export const initialState: UiState = {
  sidebarActionOrder: [
    "plugins",
    "scheduled",
    "games",
    "usage",
    "pinned",
    "chats",
    "projects",
    "remote-projects",
  ],
  hiddenSidebarActions: [],
  chatsExpanded: true,
  favouritesExpanded: true,
  lastActiveThreadId: null,
  projectExpandedById: {},
  projectOrder: [],
  projectsExpanded: true,
  remoteProjectsExpanded: false,
  selectedProjectId: null,
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
};
