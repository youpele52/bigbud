import { type ProjectId, type ThreadId } from "@bigbud/contracts";

export interface PersistedUiState {
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  favouritesExpanded?: boolean;
  projectOrderCwds?: string[];
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
}

export interface UiProjectState {
  favouritesExpanded: boolean;
  projectExpandedById: Record<string, boolean>;
  projectOrder: ProjectId[];
}

export interface UiThreadState {
  threadLastVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiState extends UiProjectState, UiThreadState {}

export interface SyncProjectInput {
  id: ProjectId;
  cwd: string | null;
}

export interface SyncThreadInput {
  id: ThreadId;
  seedVisitedAt?: string | undefined;
}

export const initialState: UiState = {
  favouritesExpanded: true,
  projectExpandedById: {},
  projectOrder: [],
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
};
