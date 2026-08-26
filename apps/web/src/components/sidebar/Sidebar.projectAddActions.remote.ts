import { useCallback, useRef, useState } from "react";

import type { ProjectId } from "@bigbud/contracts";
import { toastManager } from "../ui/toast";
import { readNativeApi } from "../../rpc/nativeApi";
import {
  getPassphraseProtectedSshKeyPath,
  getPasswordProtectedSshTargetLabel,
  getSshAuthFailureToastTitle,
} from "../../lib/ssh";
import {
  createDefaultRemoteProjectDraft,
  createRemoteProjectDraft,
  createRemoteProjectExecutionTargetId,
  getRemoteProjectConnectionLabel,
  type RemoteProjectDraft,
} from "./Sidebar.projects.logic";
import type { Project } from "../../models/types";
import { useRemoteProjectSubmit } from "./Sidebar.projectAddActions.remote.submit";
import {
  createRemoteProjectFieldErrors,
  hasRemoteProjectFieldErrors,
  type RemoteProjectField,
  type RemoteProjectFieldErrors,
} from "./Sidebar.projectAddActions.helpers";
import type {
  SidebarRemoteAgentInstallRequest,
  SidebarRemoteProjectAddActionsOutput,
  UseSidebarRemoteProjectAddActionsInput,
} from "./Sidebar.projectAddActions.remote.types";

export function useSidebarRemoteProjectAddActions({
  createProject,
  isAddingProject,
}: UseSidebarRemoteProjectAddActionsInput): SidebarRemoteProjectAddActionsOutput {
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
  const [isVerifyingRemoteProject, setIsVerifyingRemoteProject] = useState(false);
  const [isSavingRemoteProject, setIsSavingRemoteProject] = useState(false);
  const [isRemoteProjectUnlockDialogOpen, setIsRemoteProjectUnlockDialogOpen] = useState(false);
  const [remoteProjectUnlockMode, setRemoteProjectUnlockMode] = useState<
    "ssh-key-passphrase" | "password" | null
  >(null);
  const [remoteProjectUnlockKeyPath, setRemoteProjectUnlockKeyPath] = useState("");
  const [remoteProjectUnlockPassphrase, setRemoteProjectUnlockPassphrase] = useState("");
  const [remoteProjectUnlockError, setRemoteProjectUnlockError] = useState<string | null>(null);
  const [isUnlockingRemoteProjectKey, setIsUnlockingRemoteProjectKey] = useState(false);
  const [remoteProjectDialogMode, setRemoteProjectDialogMode] = useState<"add" | "edit">("add");
  const [editingProjectId, setEditingProjectId] = useState<ProjectId | null>(null);
  const [editingProjectUpdatedAt, setEditingProjectUpdatedAt] = useState<string | null>(null);
  const [remoteAgentInstallRequest, setRemoteAgentInstallRequest] =
    useState<SidebarRemoteAgentInstallRequest | null>(null);
  const verificationRequestIdRef = useRef(0);

  const resetRemoteProjectDialog = useCallback(() => {
    setIsRemoteProjectDialogOpen(false);
    setRemoteProjectDraft(createDefaultRemoteProjectDraft());
    setRemoteProjectFieldErrors({});
    setRemoteProjectError(null);
    setRemoteProjectVerificationMessage(null);
    setIsVerifyingRemoteProject(false);
    setIsSavingRemoteProject(false);
    setIsRemoteProjectUnlockDialogOpen(false);
    setRemoteProjectUnlockMode(null);
    setRemoteProjectUnlockKeyPath("");
    setRemoteProjectUnlockPassphrase("");
    setRemoteProjectUnlockError(null);
    setIsUnlockingRemoteProjectKey(false);
    setRemoteProjectDialogMode("add");
    setEditingProjectId(null);
    setEditingProjectUpdatedAt(null);
    setRemoteAgentInstallRequest(null);
    verificationRequestIdRef.current += 1;
  }, []);

  const openRemoteProjectDialog = useCallback(() => {
    setRemoteProjectDialogMode("add");
    setEditingProjectId(null);
    setEditingProjectUpdatedAt(null);
    setRemoteProjectDraft(createDefaultRemoteProjectDraft());
    setIsRemoteProjectDialogOpen(true);
    setRemoteProjectFieldErrors({});
    setRemoteProjectError(null);
  }, []);

  const openRemoteProjectEditDialog = useCallback((project: Project) => {
    const draft = createRemoteProjectDraft(project);
    if (!draft) {
      return;
    }
    verificationRequestIdRef.current += 1;
    setRemoteProjectDialogMode("edit");
    setEditingProjectId(project.id);
    setEditingProjectUpdatedAt(project.updatedAt ?? null);
    setRemoteProjectDraft(draft);
    setRemoteProjectFieldErrors({});
    setRemoteProjectError(null);
    setRemoteProjectVerificationMessage(null);
    setIsRemoteProjectDialogOpen(true);
  }, []);

  const closeRemoteProjectDialog = useCallback(() => {
    if (isAddingProject || isSavingRemoteProject || isUnlockingRemoteProjectKey) {
      return;
    }
    resetRemoteProjectDialog();
  }, [
    isAddingProject,
    isSavingRemoteProject,
    isUnlockingRemoteProjectKey,
    resetRemoteProjectDialog,
  ]);

  const updateRemoteProjectDraft = useCallback(
    <K extends RemoteProjectField | "authMode" | "providerRuntimeLocation">(
      field: K,
      value: K extends "authMode"
        ? RemoteProjectDraft["authMode"]
        : K extends "providerRuntimeLocation"
          ? RemoteProjectDraft["providerRuntimeLocation"]
          : string,
    ) => {
      verificationRequestIdRef.current += 1;
      setRemoteProjectDraft((current) => ({ ...current, [field]: value }));
      setRemoteProjectError(null);
      setRemoteProjectVerificationMessage(null);
      setIsRemoteProjectUnlockDialogOpen(false);
      setRemoteProjectUnlockMode(null);
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
    const requestId = ++verificationRequestIdRef.current;
    const nextErrors = createRemoteProjectFieldErrors(remoteProjectDraft);
    setRemoteProjectFieldErrors(nextErrors);

    if (hasRemoteProjectFieldErrors(nextErrors)) {
      setRemoteProjectError("Fix the highlighted fields before verifying the connection.");
      setRemoteProjectVerificationMessage(null);
      return "invalid" as const;
    }

    const api = readNativeApi();
    if (!api) {
      setRemoteProjectError("Native API not found.");
      setRemoteProjectVerificationMessage(null);
      return "invalid" as const;
    }

    setIsVerifyingRemoteProject(true);
    setRemoteProjectError(null);
    try {
      const result = await api.server.verifyExecutionTarget({
        executionTargetId: createRemoteProjectExecutionTargetId(remoteProjectDraft),
        cwd: remoteProjectDraft.workspaceRoot.trim(),
      });
      if (requestId !== verificationRequestIdRef.current) {
        return "invalid" as const;
      }
      if (
        result.remoteAgent?.status === "install-required" ||
        result.remoteAgent?.status === "upgrade-required"
      ) {
        setRemoteProjectVerificationMessage(null);
        const request = {
          candidate: remoteProjectDraft,
          executionTargetId: createRemoteProjectExecutionTargetId(remoteProjectDraft),
          targetLabel: getRemoteProjectConnectionLabel(remoteProjectDraft),
          ...(result.remoteAgent.status === "upgrade-required"
            ? {
                kind: "upgrade" as const,
                currentVersion: result.remoteAgent.currentVersion,
                targetVersion: result.remoteAgent.targetVersion,
              }
            : { kind: "install" as const }),
        };
        setRemoteAgentInstallRequest(request);
        return result.remoteAgent.status;
      }
      setRemoteProjectVerificationMessage(result.message);
      return "verified" as const;
    } catch (error) {
      if (requestId !== verificationRequestIdRef.current) {
        return "invalid" as const;
      }
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to verify the SSH connection for this remote project.";
      const lockedKeyPath = getPassphraseProtectedSshKeyPath(errorMessage);
      const passwordTargetLabel = getPasswordProtectedSshTargetLabel(errorMessage);
      setRemoteProjectVerificationMessage(null);
      if (lockedKeyPath) {
        setRemoteProjectError(null);
        setRemoteProjectUnlockMode("ssh-key-passphrase");
        setRemoteProjectUnlockKeyPath(lockedKeyPath);
        setRemoteProjectUnlockPassphrase("");
        setRemoteProjectUnlockError(null);
        setIsRemoteProjectUnlockDialogOpen(true);
        return "unlock-required" as const;
      }
      if (passwordTargetLabel) {
        setRemoteProjectError(null);
        setRemoteProjectUnlockMode("password");
        setRemoteProjectUnlockKeyPath(passwordTargetLabel);
        setRemoteProjectUnlockPassphrase("");
        setRemoteProjectUnlockError(null);
        setIsRemoteProjectUnlockDialogOpen(true);
        return "unlock-required" as const;
      }
      setRemoteProjectError(errorMessage);
      return "invalid" as const;
    } finally {
      if (requestId === verificationRequestIdRef.current) {
        setIsVerifyingRemoteProject(false);
      }
    }
  }, [remoteProjectDraft]);

  const submitRemoteProject = useRemoteProjectSubmit({
    createProject,
    dialogMode: remoteProjectDialogMode,
    editingProjectId,
    editingProjectUpdatedAt,
    resetDialog: resetRemoteProjectDialog,
    setError: setRemoteProjectError,
    setSaving: setIsSavingRemoteProject,
  });

  const declineRemoteAgentInstall = useCallback(() => {
    resetRemoteProjectDialog();
  }, [resetRemoteProjectDialog]);

  const completeRemoteAgentInstall = useCallback(
    async (message: string) => {
      const request = remoteAgentInstallRequest;
      if (!request) return;
      setRemoteAgentInstallRequest(null);
      setRemoteProjectVerificationMessage(message);
      await submitRemoteProject(request.candidate);
    },
    [remoteAgentInstallRequest, submitRemoteProject],
  );

  const submitRemoteProjectDialog = useCallback(async () => {
    if (isSavingRemoteProject || isVerifyingRemoteProject) {
      return;
    }
    setRemoteProjectError(null);
    const candidate = remoteProjectDraft;
    const requestId = verificationRequestIdRef.current + 1;
    const verificationState = await verifyRemoteProjectDialog();
    if (verificationState !== "verified" || requestId !== verificationRequestIdRef.current) {
      return;
    }

    await submitRemoteProject(candidate);
  }, [
    isSavingRemoteProject,
    isVerifyingRemoteProject,
    remoteProjectDraft,
    submitRemoteProject,
    verifyRemoteProjectDialog,
  ]);

  const closeRemoteProjectUnlockDialog = useCallback(() => {
    if (isUnlockingRemoteProjectKey) {
      return;
    }
    setIsRemoteProjectUnlockDialogOpen(false);
    setRemoteProjectUnlockMode(null);
    setRemoteProjectUnlockKeyPath("");
    setRemoteProjectUnlockPassphrase("");
    setRemoteProjectUnlockError(null);
  }, [isUnlockingRemoteProjectKey]);

  const submitRemoteProjectUnlock = useCallback(async () => {
    const secret = remoteProjectUnlockPassphrase.trim();
    if (secret.length === 0) {
      setRemoteProjectUnlockError(
        remoteProjectUnlockMode === "password"
          ? "Enter the SSH password."
          : "Enter the SSH key passphrase.",
      );
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
      if (remoteProjectUnlockMode === "password") {
        await api.server.unlockSshPassword({
          executionTargetId,
          password: secret,
        });
      } else {
        await api.server.unlockSshKey({
          executionTargetId,
          passphrase: secret,
        });
      }
      setIsRemoteProjectUnlockDialogOpen(false);
      setRemoteProjectUnlockMode(null);
      setRemoteProjectUnlockPassphrase("");
      setRemoteProjectUnlockKeyPath("");

      const verificationState = await verifyRemoteProjectDialog();
      if (verificationState !== "verified") {
        return;
      }

      await submitRemoteProject(remoteProjectDraft);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : remoteProjectUnlockMode === "password"
            ? "Failed to unlock the SSH password session."
            : "Failed to unlock the SSH key.";
      setRemoteProjectUnlockError(errorMessage);
      if (remoteProjectUnlockMode) {
        toastManager.add({
          type: "error",
          title: getSshAuthFailureToastTitle(remoteProjectUnlockMode),
          description: errorMessage,
        });
      }
    } finally {
      setIsUnlockingRemoteProjectKey(false);
    }
  }, [
    remoteProjectDraft,
    remoteProjectUnlockMode,
    remoteProjectUnlockPassphrase,
    submitRemoteProject,
    verifyRemoteProjectDialog,
  ]);

  return {
    remoteProjectDialogMode,
    isRemoteProjectDialogOpen,
    remoteProjectDraft,
    remoteProjectFieldErrors,
    remoteProjectError,
    remoteProjectVerificationMessage,
    isVerifyingRemoteProject,
    isSavingRemoteProject,
    openRemoteProjectDialog,
    openRemoteProjectEditDialog,
    closeRemoteProjectDialog,
    updateRemoteProjectDraft,
    submitRemoteProjectDialog,
    remoteAgentInstallRequest,
    declineRemoteAgentInstall,
    completeRemoteAgentInstall,
    isRemoteProjectUnlockDialogOpen,
    remoteProjectUnlockMode,
    remoteProjectUnlockKeyPath,
    remoteProjectUnlockPassphrase,
    remoteProjectUnlockError,
    isUnlockingRemoteProjectKey,
    closeRemoteProjectUnlockDialog,
    setRemoteProjectUnlockPassphrase,
    submitRemoteProjectUnlock,
  };
}
