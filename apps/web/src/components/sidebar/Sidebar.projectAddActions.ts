import { useCallback, useRef, useState, type RefObject } from "react";

import type { ProjectId } from "@bigbud/contracts";

import { isElectron } from "../../config/env";
import type { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { buildExplicitExecutionTargets } from "../../lib/providerExecutionTargets";
import { dispatchCommandWithOutcomeRecovery } from "../../lib/orchestrationCommandRecovery";
import { newCommandId, newProjectId } from "../../lib/utils";
import type { Project } from "../../models/types";
import { getDefaultModelSelection } from "../../models/provider/provider.models";
import { readNativeApi } from "../../rpc/nativeApi";
import type { useServerProviders } from "../../rpc/serverState";
import { toastManager } from "../ui/toast";
import {
  deriveProjectTitleFromCwd,
  isRemoteExecutionTargetId,
} from "./Sidebar.remoteWorkspaces.logic";
import type { CreateProjectInput, CreateProjectResult } from "./Sidebar.projectAddActions.helpers";
import { useSidebarRemoteWorkspaceAddActions } from "./Sidebar.remoteWorkspaceAddActions";
import type { SidebarRemoteWorkspaceAddActionsOutput } from "./Sidebar.remoteWorkspaceAddActions.types";

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
  isRemoteWorkspaceDialogOpen: SidebarRemoteWorkspaceAddActionsOutput["isRemoteWorkspaceDialogOpen"];
  remoteWorkspaceDialogMode: SidebarRemoteWorkspaceAddActionsOutput["remoteWorkspaceDialogMode"];
  remoteWorkspaceDraft: SidebarRemoteWorkspaceAddActionsOutput["remoteWorkspaceDraft"];
  remoteWorkspaceFieldErrors: SidebarRemoteWorkspaceAddActionsOutput["remoteWorkspaceFieldErrors"];
  remoteWorkspaceError: SidebarRemoteWorkspaceAddActionsOutput["remoteWorkspaceError"];
  remoteWorkspaceVerificationMessage: SidebarRemoteWorkspaceAddActionsOutput["remoteWorkspaceVerificationMessage"];
  isVerifyingRemoteWorkspace: SidebarRemoteWorkspaceAddActionsOutput["isVerifyingRemoteWorkspace"];
  isSavingRemoteWorkspace: SidebarRemoteWorkspaceAddActionsOutput["isSavingRemoteWorkspace"];
  openRemoteWorkspaceDialog: SidebarRemoteWorkspaceAddActionsOutput["openRemoteWorkspaceDialog"];
  openRemoteWorkspaceEditDialog: SidebarRemoteWorkspaceAddActionsOutput["openRemoteWorkspaceEditDialog"];
  closeRemoteWorkspaceDialog: SidebarRemoteWorkspaceAddActionsOutput["closeRemoteWorkspaceDialog"];
  updateRemoteWorkspaceDraft: SidebarRemoteWorkspaceAddActionsOutput["updateRemoteWorkspaceDraft"];
  adoptRemoteWorkspaceConnectionSource: SidebarRemoteWorkspaceAddActionsOutput["adoptRemoteWorkspaceConnectionSource"];
  submitRemoteWorkspaceDialog: SidebarRemoteWorkspaceAddActionsOutput["submitRemoteWorkspaceDialog"];
  requestRemoteWorkspaceUnlock: SidebarRemoteWorkspaceAddActionsOutput["requestRemoteWorkspaceUnlock"];
  remoteAgentInstallRequest: SidebarRemoteWorkspaceAddActionsOutput["remoteAgentInstallRequest"];
  declineRemoteAgentInstall: SidebarRemoteWorkspaceAddActionsOutput["declineRemoteAgentInstall"];
  completeRemoteAgentInstall: SidebarRemoteWorkspaceAddActionsOutput["completeRemoteAgentInstall"];
  isRemoteWorkspaceUnlockDialogOpen: SidebarRemoteWorkspaceAddActionsOutput["isRemoteWorkspaceUnlockDialogOpen"];
  remoteWorkspaceUnlockMode: SidebarRemoteWorkspaceAddActionsOutput["remoteWorkspaceUnlockMode"];
  remoteWorkspaceUnlockKeyPath: SidebarRemoteWorkspaceAddActionsOutput["remoteWorkspaceUnlockKeyPath"];
  remoteWorkspaceUnlockPassphrase: SidebarRemoteWorkspaceAddActionsOutput["remoteWorkspaceUnlockPassphrase"];
  remoteWorkspaceUnlockError: SidebarRemoteWorkspaceAddActionsOutput["remoteWorkspaceUnlockError"];
  isUnlockingRemoteWorkspaceKey: SidebarRemoteWorkspaceAddActionsOutput["isUnlockingRemoteWorkspaceKey"];
  closeRemoteWorkspaceUnlockDialog: SidebarRemoteWorkspaceAddActionsOutput["closeRemoteWorkspaceUnlockDialog"];
  setRemoteWorkspaceUnlockPassphrase: SidebarRemoteWorkspaceAddActionsOutput["setRemoteWorkspaceUnlockPassphrase"];
  submitRemoteWorkspaceUnlock: SidebarRemoteWorkspaceAddActionsOutput["submitRemoteWorkspaceUnlock"];
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

  const resetLocalProjectFlow = useCallback(() => {
    setAddingProject(false);
    setNewCwd("");
    setAddProjectError(null);
  }, []);

  const createProject = useCallback(
    async ({
      rawCwd,
      providerRuntimeLocation,
      workspaceExecutionTargetId,
      title,
    }: CreateProjectInput): Promise<CreateProjectResult> => {
      const cwd = rawCwd.trim();
      const itemLabel = isRemoteExecutionTargetId(workspaceExecutionTargetId)
        ? "Remote workspace"
        : "Project";
      if (!cwd || isAddingProject) {
        return { ok: false, error: `${itemLabel} path is required.` };
      }

      const executionTargets = buildExplicitExecutionTargets({
        workspaceExecutionTargetId,
        providerRuntimeLocation,
      });
      const api = readNativeApi();
      if (!api) {
        return { ok: false, error: "Native API not found." };
      }

      const existing = projects.find(
        (project) =>
          project.cwd === cwd &&
          (project.workspaceExecutionTargetId ?? project.executionTargetId ?? "local") ===
            executionTargets.workspaceExecutionTargetId,
      );
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        return { ok: true };
      }

      setIsAddingProject(true);
      try {
        const projectId = newProjectId();
        const createdAt = new Date().toISOString();

        await dispatchCommandWithOutcomeRecovery(api, {
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

        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : `An error occurred while adding the ${itemLabel.toLowerCase()}.`,
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

  const remoteWorkspaceActions = useSidebarRemoteWorkspaceAddActions({
    createProject,
    isAddingProject,
  });

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
    ...remoteWorkspaceActions,
  };
}
