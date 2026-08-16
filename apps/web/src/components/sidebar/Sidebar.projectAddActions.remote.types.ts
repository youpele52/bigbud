import type { Project } from "../../models/types";
import type { ProviderRuntimeLocation } from "../../lib/providerExecutionTargets";
import type { RemoteProjectAuthMode, RemoteProjectDraft } from "./Sidebar.projects.logic";
import type {
  CreateProjectInput,
  CreateProjectResult,
  RemoteProjectField,
  RemoteProjectFieldErrors,
} from "./Sidebar.projectAddActions.helpers";

export interface UseSidebarRemoteProjectAddActionsInput {
  readonly createProject: (input: CreateProjectInput) => Promise<CreateProjectResult>;
  readonly isAddingProject: boolean;
}

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
  readonly updateRemoteProjectDraft: <
    K extends RemoteProjectField | "authMode" | "providerRuntimeLocation",
  >(
    field: K,
    value: K extends "authMode"
      ? RemoteProjectAuthMode
      : K extends "providerRuntimeLocation"
        ? ProviderRuntimeLocation
        : string,
  ) => void;
  readonly submitRemoteProjectDialog: () => Promise<void>;
  readonly isRemoteProjectUnlockDialogOpen: boolean;
  readonly remoteProjectUnlockMode: "ssh-key-passphrase" | "password" | null;
  readonly remoteProjectUnlockKeyPath: string;
  readonly remoteProjectUnlockPassphrase: string;
  readonly remoteProjectUnlockError: string | null;
  readonly isUnlockingRemoteProjectKey: boolean;
  readonly closeRemoteProjectUnlockDialog: () => void;
  readonly setRemoteProjectUnlockPassphrase: (passphrase: string) => void;
  readonly submitRemoteProjectUnlock: () => Promise<void>;
}
