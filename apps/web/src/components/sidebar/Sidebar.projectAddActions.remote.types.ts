import type { Project } from "../../models/types";
import type {
  RemoteProjectConnectionSource,
  RemoteProjectDraft,
  RequestRemoteProjectUnlock,
  UpdateRemoteProjectDraft,
} from "./Sidebar.projects.logic";
import type {
  CreateProjectInput,
  CreateProjectResult,
  RemoteProjectFieldErrors,
} from "./Sidebar.projectAddActions.helpers";

export interface UseSidebarRemoteProjectAddActionsInput {
  readonly createProject: (input: CreateProjectInput) => Promise<CreateProjectResult>;
  readonly isAddingProject: boolean;
}

export type SidebarRemoteAgentInstallRequest = {
  readonly candidate: RemoteProjectDraft;
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

export interface SidebarRemoteProjectAddActionsOutput {
  readonly remoteProjectDialogMode: "add" | "edit";
  readonly isRemoteProjectDialogOpen: boolean;
  readonly remoteProjectDraft: RemoteProjectDraft;
  readonly remoteProjectFieldErrors: RemoteProjectFieldErrors;
  readonly remoteProjectError: string | null;
  readonly remoteProjectVerificationMessage: string | null;
  readonly isVerifyingRemoteProject: boolean;
  readonly isSavingRemoteProject: boolean;
  readonly openRemoteProjectDialog: () => void;
  readonly openRemoteProjectEditDialog: (project: Project) => void;
  readonly closeRemoteProjectDialog: () => void;
  readonly updateRemoteProjectDraft: UpdateRemoteProjectDraft;
  readonly adoptRemoteProjectConnectionSource: (source: RemoteProjectConnectionSource) => void;
  /** Opens the unlock prompt for an SSH lock error; the continuation runs after unlocking. */
  readonly requestRemoteProjectUnlock: RequestRemoteProjectUnlock;
  readonly submitRemoteProjectDialog: () => Promise<void>;
  readonly remoteAgentInstallRequest: SidebarRemoteAgentInstallRequest | null;
  readonly declineRemoteAgentInstall: () => void;
  readonly completeRemoteAgentInstall: (message: string) => Promise<void>;
  readonly isRemoteProjectUnlockDialogOpen: boolean;
  readonly remoteProjectUnlockMode: import("../../lib/ssh").SshAuthMode | null;
  readonly remoteProjectUnlockKeyPath: string;
  readonly remoteProjectUnlockPassphrase: string;
  readonly remoteProjectUnlockError: string | null;
  readonly isUnlockingRemoteProjectKey: boolean;
  readonly closeRemoteProjectUnlockDialog: () => void;
  readonly setRemoteProjectUnlockPassphrase: (passphrase: string) => void;
  readonly submitRemoteProjectUnlock: () => Promise<void>;
}
