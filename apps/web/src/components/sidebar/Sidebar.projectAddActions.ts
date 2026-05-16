import { useCallback, useRef, useState, type RefObject } from "react";
import type { Project } from "../../models/types";
import { getDefaultModelSelection } from "../../models/provider/provider.models";
import { readNativeApi } from "../../rpc/nativeApi";
import { toastManager } from "../ui/toast";
import { isElectron } from "../../config/env";
import { buildExplicitExecutionTargets } from "../../lib/providerExecutionTargets";
import { getPassphraseProtectedSshKeyPath } from "../../lib/ssh";
import { newCommandId, newProjectId } from "../../lib/utils";
import type { useHandleNewThread } from "../../hooks/useHandleNewThread";
import type { useServerProviders } from "../../rpc/serverState";
import type { ProjectId } from "@bigbud/contracts";
import {
  createDefaultRemoteProjectDraft,
  createRemoteProjectExecutionTargetId,
  createRemoteProjectVerificationKey,
  deriveProjectTitleFromCwd,
  getRemoteProjectConnectionLabel,
  type RemoteProjectDraft,
} from "./Sidebar.projects.logic";
import {
  createRemoteProjectFieldErrors,
  hasRemoteProjectFieldErrors,
  type CreateProjectInput,
  type RemoteProjectField,
  type RemoteProjectFieldErrors,
} from "./Sidebar.projectAddActions.helpers";

interface UseSidebarProjectAddActionsInput {
  projects: Project[];
  focusMostRecentThreadForProject: (projectId: ProjectId) => void;
  handleNewThread: ReturnType<typeof useHandleNewThread>["handleNewThread"];
  defaultThreadEnvMode: "local" | "worktree";
  serverProviders: ReturnType<typeof useServerProviders>;
}

export interface SidebarProjectAddActionsOutput {
  addingProject: boolean;
  newCwd: string;
  isPickingFolder: boolean;
  isAddingProject: boolean;
  addProjectError: string | null;
  addProjectInputRef: RefObject<HTMLInputElement | null>;
  shouldShowProjectPathEntry: boolean;
  setNewCwd: (cwd: string) => void;
  setAddProjectError: (error: string | null) => void;
  handleStartAddProject: () => void;
  handleAddProject: () => void;
  handlePickFolder: () => Promise<void>;
  cancelAddProject: () => void;
  isRemoteProjectDialogOpen: boolean;
  remoteProjectDraft: RemoteProjectDraft;
  remoteProjectFieldErrors: RemoteProjectFieldErrors;
  remoteProjectError: string | null;
  remoteProjectVerificationMessage: string | null;
  isVerifyingRemoteProject: boolean;
  openRemoteProjectDialog: () => void;
  closeRemoteProjectDialog: () => void;
  updateRemoteProjectDraft: <K extends RemoteProjectField | "authMode" | "providerRuntimeLocation">(
    field: K,
    value: K extends "authMode"
      ? RemoteProjectDraft["authMode"]
      : K extends "providerRuntimeLocation"
        ? RemoteProjectDraft["providerRuntimeLocation"]
        : string,
  ) => void;
  submitRemoteProjectDialog: () => Promise<void>;
  isRemoteProjectUnlockDialogOpen: boolean;
  remoteProjectUnlockKeyPath: string;
  remoteProjectUnlockPassphrase: string;
  remoteProjectUnlockError: string | null;
  isUnlockingRemoteProjectKey: boolean;
  closeRemoteProjectUnlockDialog: () => void;
  setRemoteProjectUnlockPassphrase: (passphrase: string) => void;
  submitRemoteProjectUnlock: () => Promise<void>;
}

export function useSidebarProjectAddActions({
  projects,
  focusMostRecentThreadForProject,
  handleNewThread,
  defaultThreadEnvMode,
  serverProviders,
}: UseSidebarProjectAddActionsInput): SidebarProjectAddActionsOutput {
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);

  const [isRemoteProjectDialogOpen, setIsRemoteProjectDialogOpen] = useState(false);
  const [remoteProjectDraft, setRemoteProjectDraft] = useState<RemoteProjectDraft>(
    createDefaultRemoteProjectDraft,
  );
  const [remoteProjectFieldErrors, setRemoteProjectFieldErrors] =
    useState<RemoteProjectFieldErrors>({});
  const [remoteProjectError, setRemoteProjectError] = useState<string | null>(null);
  const [remoteProjectVerificationMessage, setRemoteProjectVerificationMessage] = useState<
    string | null
  >(null);
  const [remoteProjectVerifiedKey, setRemoteProjectVerifiedKey] = useState<string | null>(null);
  const [isVerifyingRemoteProject, setIsVerifyingRemoteProject] = useState(false);
  const [isRemoteProjectUnlockDialogOpen, setIsRemoteProjectUnlockDialogOpen] = useState(false);
  const [remoteProjectUnlockKeyPath, setRemoteProjectUnlockKeyPath] = useState("");
  const [remoteProjectUnlockPassphrase, setRemoteProjectUnlockPassphrase] = useState("");
  const [remoteProjectUnlockError, setRemoteProjectUnlockError] = useState<string | null>(null);
  const [isUnlockingRemoteProjectKey, setIsUnlockingRemoteProjectKey] = useState(false);

  const resetLocalProjectFlow = useCallback(() => {
    setAddingProject(false);
    setNewCwd("");
    setAddProjectError(null);
  }, []);

  const resetRemoteProjectDialog = useCallback(() => {
    setIsRemoteProjectDialogOpen(false);
    setRemoteProjectDraft(createDefaultRemoteProjectDraft());
    setRemoteProjectFieldErrors({});
    setRemoteProjectError(null);
    setRemoteProjectVerificationMessage(null);
    setRemoteProjectVerifiedKey(null);
    setIsVerifyingRemoteProject(false);
    setIsRemoteProjectUnlockDialogOpen(false);
    setRemoteProjectUnlockKeyPath("");
    setRemoteProjectUnlockPassphrase("");
    setRemoteProjectUnlockError(null);
    setIsUnlockingRemoteProjectKey(false);
  }, []);

  const createProject = useCallback(
    async ({
      rawCwd,
      providerRuntimeLocation,
      workspaceExecutionTargetId,
      title,
    }: CreateProjectInput) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) {
        return { ok: false as const, error: "Project path is required." };
      }
      const executionTargets = buildExplicitExecutionTargets({
        workspaceExecutionTargetId,
        providerRuntimeLocation,
      });

      const api = readNativeApi();
      if (!api) {
        return { ok: false as const, error: "Native API not found." };
      }

      const existing = projects.find(
        (project) =>
          project.cwd === cwd &&
          (project.workspaceExecutionTargetId ?? project.executionTargetId ?? "local") ===
            executionTargets.workspaceExecutionTargetId,
      );
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        return { ok: true as const };
      }

      setIsAddingProject(true);
      try {
        const projectId = newProjectId();
        const createdAt = new Date().toISOString();

        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          ...executionTargets,
          workspaceRoot: cwd,
          defaultModelSelection: getDefaultModelSelection(serverProviders),
          createdAt,
        });

        await handleNewThread(projectId, {
          envMode: defaultThreadEnvMode,
        }).catch(() => undefined);

        return { ok: true as const };
      } catch (error) {
        return {
          ok: false as const,
          error:
            error instanceof Error ? error.message : "An error occurred while adding the project.",
        };
      } finally {
        setIsAddingProject(false);
      }
    },
    [
      defaultThreadEnvMode,
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      serverProviders,
    ],
  );

  const handleAddProject = useCallback(async () => {
    const result = await createProject({
      rawCwd: newCwd,
      providerRuntimeLocation: "local",
      workspaceExecutionTargetId: "local",
      title: deriveProjectTitleFromCwd(newCwd),
    });

    if (!result.ok) {
      setAddProjectError(result.error);
      return;
    }

    resetLocalProjectFlow();
  }, [createProject, newCwd, resetLocalProjectFlow]);

  const handlePickFolder = useCallback(async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) {
      return;
    }

    setIsPickingFolder(true);
    try {
      const pickedPath = await api.dialogs.pickFolder();
      if (!pickedPath) {
        if (addingProject) {
          addProjectInputRef.current?.focus();
        }
        return;
      }

      const result = await createProject({
        rawCwd: pickedPath,
        providerRuntimeLocation: "local",
        workspaceExecutionTargetId: "local",
        title: deriveProjectTitleFromCwd(pickedPath),
      });

      if (!result.ok) {
        if (addingProject) {
          setAddProjectError(result.error);
        } else {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description: result.error,
          });
        }
        return;
      }

      resetLocalProjectFlow();
    } finally {
      setIsPickingFolder(false);
    }
  }, [addingProject, createProject, isPickingFolder, resetLocalProjectFlow]);

  const handleStartAddProject = useCallback(() => {
    setAddProjectError(null);
    if (isElectron) {
      void handlePickFolder();
      return;
    }
    setAddingProject((current) => !current);
  }, [handlePickFolder]);

  const cancelAddProject = useCallback(() => {
    resetLocalProjectFlow();
  }, [resetLocalProjectFlow]);

  const openRemoteProjectDialog = useCallback(() => {
    setAddingProject(false);
    setAddProjectError(null);
    setIsRemoteProjectDialogOpen(true);
    setRemoteProjectFieldErrors({});
    setRemoteProjectError(null);
  }, []);

  const closeRemoteProjectDialog = useCallback(() => {
    if (isAddingProject || isUnlockingRemoteProjectKey) {
      return;
    }
    resetRemoteProjectDialog();
  }, [isAddingProject, isUnlockingRemoteProjectKey, resetRemoteProjectDialog]);

  const updateRemoteProjectDraft = useCallback(
    <K extends RemoteProjectField | "authMode" | "providerRuntimeLocation">(
      field: K,
      value: K extends "authMode"
        ? RemoteProjectDraft["authMode"]
        : K extends "providerRuntimeLocation"
          ? RemoteProjectDraft["providerRuntimeLocation"]
          : string,
    ) => {
      setRemoteProjectDraft((current) => ({ ...current, [field]: value }));
      setRemoteProjectError(null);
      setRemoteProjectVerificationMessage(null);
      setRemoteProjectVerifiedKey(null);
      setIsRemoteProjectUnlockDialogOpen(false);
      setRemoteProjectUnlockKeyPath("");
      setRemoteProjectUnlockPassphrase("");
      setRemoteProjectUnlockError(null);
      setRemoteProjectFieldErrors((current) => {
        if (!(field in current)) {
          return current;
        }
        const next = { ...current };
        delete next[field as RemoteProjectField];
        return next;
      });
    },
    [],
  );

  const verifyRemoteProjectDialog = useCallback(async () => {
    const nextErrors = createRemoteProjectFieldErrors(remoteProjectDraft);
    setRemoteProjectFieldErrors(nextErrors);

    if (hasRemoteProjectFieldErrors(nextErrors)) {
      setRemoteProjectError("Fix the highlighted fields before verifying the connection.");
      setRemoteProjectVerificationMessage(null);
      setRemoteProjectVerifiedKey(null);
      return "invalid" as const;
    }

    if (remoteProjectDraft.authMode !== "ssh-key") {
      setRemoteProjectError("Password SSH authentication is not supported yet. Use an SSH key.");
      setRemoteProjectVerificationMessage(null);
      setRemoteProjectVerifiedKey(null);
      return "invalid" as const;
    }

    const api = readNativeApi();
    if (!api) {
      setRemoteProjectError("Native API not found.");
      setRemoteProjectVerificationMessage(null);
      setRemoteProjectVerifiedKey(null);
      return "invalid" as const;
    }

    setIsVerifyingRemoteProject(true);
    setRemoteProjectError(null);
    try {
      const result = await api.server.verifyExecutionTarget({
        executionTargetId: createRemoteProjectExecutionTargetId(remoteProjectDraft),
        cwd: remoteProjectDraft.workspaceRoot.trim(),
      });
      setRemoteProjectVerificationMessage(result.message);
      setRemoteProjectVerifiedKey(createRemoteProjectVerificationKey(remoteProjectDraft));
      return "verified" as const;
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to verify the SSH connection for this remote project.";
      const lockedKeyPath = getPassphraseProtectedSshKeyPath(errorMessage);
      setRemoteProjectVerificationMessage(null);
      setRemoteProjectVerifiedKey(null);
      if (lockedKeyPath) {
        setRemoteProjectError(null);
        setRemoteProjectUnlockKeyPath(lockedKeyPath);
        setRemoteProjectUnlockPassphrase("");
        setRemoteProjectUnlockError(null);
        setIsRemoteProjectUnlockDialogOpen(true);
        return "unlock-required" as const;
      }
      setRemoteProjectError(errorMessage);
      return "invalid" as const;
    } finally {
      setIsVerifyingRemoteProject(false);
    }
  }, [remoteProjectDraft]);

  const submitRemoteProject = useCallback(async () => {
    const remoteTargetLabel = getRemoteProjectConnectionLabel(remoteProjectDraft);
    const title =
      remoteProjectDraft.displayName.trim().length > 0
        ? remoteProjectDraft.displayName.trim()
        : `${deriveProjectTitleFromCwd(remoteProjectDraft.workspaceRoot)} (${remoteTargetLabel})`;

    const result = await createProject({
      rawCwd: remoteProjectDraft.workspaceRoot,
      providerRuntimeLocation: remoteProjectDraft.providerRuntimeLocation,
      workspaceExecutionTargetId: createRemoteProjectExecutionTargetId(remoteProjectDraft),
      title,
    });

    if (!result.ok) {
      setRemoteProjectError(result.error);
      return;
    }

    resetRemoteProjectDialog();
  }, [createProject, remoteProjectDraft, resetRemoteProjectDialog]);

  const submitRemoteProjectDialog = useCallback(async () => {
    setRemoteProjectError(null);
    if (remoteProjectVerifiedKey !== createRemoteProjectVerificationKey(remoteProjectDraft)) {
      const verificationState = await verifyRemoteProjectDialog();
      if (verificationState !== "verified") {
        return;
      }
    }

    await submitRemoteProject();
  }, [
    remoteProjectDraft,
    remoteProjectVerifiedKey,
    submitRemoteProject,
    verifyRemoteProjectDialog,
  ]);

  const closeRemoteProjectUnlockDialog = useCallback(() => {
    if (isUnlockingRemoteProjectKey) {
      return;
    }
    setIsRemoteProjectUnlockDialogOpen(false);
    setRemoteProjectUnlockKeyPath("");
    setRemoteProjectUnlockPassphrase("");
    setRemoteProjectUnlockError(null);
  }, [isUnlockingRemoteProjectKey]);

  const submitRemoteProjectUnlock = useCallback(async () => {
    const passphrase = remoteProjectUnlockPassphrase;
    if (passphrase.trim().length === 0) {
      setRemoteProjectUnlockError("Enter the SSH key passphrase.");
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setRemoteProjectUnlockError("Native API not found.");
      return;
    }

    setIsUnlockingRemoteProjectKey(true);
    setRemoteProjectUnlockError(null);
    try {
      const executionTargetId = createRemoteProjectExecutionTargetId(remoteProjectDraft);
      await api.server.unlockSshKey({
        executionTargetId,
        passphrase,
      });
      setIsRemoteProjectUnlockDialogOpen(false);
      setRemoteProjectUnlockPassphrase("");
      setRemoteProjectUnlockKeyPath("");

      const verificationState = await verifyRemoteProjectDialog();
      if (verificationState !== "verified") {
        return;
      }

      await submitRemoteProject();
    } catch (error) {
      setRemoteProjectUnlockError(
        error instanceof Error ? error.message : "Failed to unlock the SSH key.",
      );
    } finally {
      setIsUnlockingRemoteProjectKey(false);
    }
  }, [
    remoteProjectDraft,
    remoteProjectUnlockPassphrase,
    submitRemoteProject,
    verifyRemoteProjectDialog,
  ]);

  return {
    addingProject,
    newCwd,
    isPickingFolder,
    isAddingProject,
    addProjectError,
    addProjectInputRef,
    shouldShowProjectPathEntry: addingProject,
    setNewCwd,
    setAddProjectError,
    handleStartAddProject,
    handleAddProject: () => {
      void handleAddProject();
    },
    handlePickFolder,
    cancelAddProject,
    isRemoteProjectDialogOpen,
    remoteProjectDraft,
    remoteProjectFieldErrors,
    remoteProjectError,
    remoteProjectVerificationMessage,
    isVerifyingRemoteProject,
    openRemoteProjectDialog,
    closeRemoteProjectDialog,
    updateRemoteProjectDraft,
    submitRemoteProjectDialog,
    isRemoteProjectUnlockDialogOpen,
    remoteProjectUnlockKeyPath,
    remoteProjectUnlockPassphrase,
    remoteProjectUnlockError,
    isUnlockingRemoteProjectKey,
    closeRemoteProjectUnlockDialog,
    setRemoteProjectUnlockPassphrase,
    submitRemoteProjectUnlock,
  };
}
