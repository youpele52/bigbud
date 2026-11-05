import type { Project } from "../../models/types";
import type {
  RemoteWorkspaceConnectionSource,
  RemoteWorkspaceDraft,
  RequestRemoteWorkspaceUnlock,
  UpdateRemoteWorkspaceDraft,
} from "./Sidebar.remoteWorkspaces.logic";
import type {
  CreateProjectInput,
  CreateProjectResult,
  RemoteWorkspaceFieldErrors,
} from "./Sidebar.projectAddActions.helpers";

export interface UseSidebarRemoteWorkspaceAddActionsInput {
  readonly createProject: (input: CreateProjectInput) => Promise<CreateProjectResult>;
  readonly isAddingProject: boolean;
}

export type SidebarRemoteAgentInstallRequest = {
  readonly candidate: RemoteWorkspaceDraft;
  readonly executionTargetId: string;
  readonly targetLabel: string;
} & (
  | { readonly kind: "install" }
  | {
      readonly kind: "upgrade";
      readonly currentVersion: string;
      readonly targetVersion: string;
    }
);

export interface SidebarRemoteWorkspaceAddActionsOutput {
  readonly remoteWorkspaceDialogMode: "add" | "edit";
  readonly isRemoteWorkspaceDialogOpen: boolean;
  readonly remoteWorkspaceDraft: RemoteWorkspaceDraft;
  readonly remoteWorkspaceFieldErrors: RemoteWorkspaceFieldErrors;
  readonly remoteWorkspaceError: string | null;
  readonly remoteWorkspaceVerificationMessage: string | null;
  readonly isVerifyingRemoteWorkspace: boolean;
  readonly isSavingRemoteWorkspace: boolean;
  readonly openRemoteWorkspaceDialog: () => void;
  readonly openRemoteWorkspaceEditDialog: (project: Project) => void;
  readonly closeRemoteWorkspaceDialog: () => void;
  readonly updateRemoteWorkspaceDraft: UpdateRemoteWorkspaceDraft;
  readonly adoptRemoteWorkspaceConnectionSource: (source: RemoteWorkspaceConnectionSource) => void;
  /** Opens the unlock prompt for an SSH lock error; the continuation runs after unlocking. */
  readonly requestRemoteWorkspaceUnlock: RequestRemoteWorkspaceUnlock;
  readonly submitRemoteWorkspaceDialog: () => Promise<void>;
  readonly remoteAgentInstallRequest: SidebarRemoteAgentInstallRequest | null;
  readonly declineRemoteAgentInstall: () => void;
  readonly completeRemoteAgentInstall: (message: string) => Promise<void>;
  readonly isRemoteWorkspaceUnlockDialogOpen: boolean;
  readonly remoteWorkspaceUnlockMode: import("../../lib/ssh").SshAuthMode | null;
  readonly remoteWorkspaceUnlockKeyPath: string;
  readonly remoteWorkspaceUnlockPassphrase: string;
  readonly remoteWorkspaceUnlockError: string | null;
  readonly isUnlockingRemoteWorkspaceKey: boolean;
  readonly closeRemoteWorkspaceUnlockDialog: () => void;
  readonly setRemoteWorkspaceUnlockPassphrase: (passphrase: string) => void;
  readonly submitRemoteWorkspaceUnlock: () => Promise<void>;
}
