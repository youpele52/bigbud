import { useCallback, useRef, useState } from "react";

import type { ProjectId } from "@bigbud/contracts";
import { readNativeApi } from "../../rpc/nativeApi";
import {
  applyRemoteProjectDraftChange,
  createDefaultRemoteProjectDraft,
  createRemoteProjectDraft,
  createRemoteProjectExecutionTargetId,
  getRemoteProjectConnectionLabel,
  type RemoteProjectConnectionSource,
  type RemoteProjectDraft,
  type RemoteProjectDraftField,
} from "./Sidebar.projects.logic";
import { readLastRemoteProjectConnectionSource } from "./Sidebar.projects.connectionSourcePreference";
import type { Project } from "../../models/types";
import { useRemoteProjectSubmit } from "./Sidebar.projectAddActions.remote.submit";
import { useRemoteProjectUnlock } from "./Sidebar.projectAddActions.remote.unlock";
import {
  createRemoteProjectFieldErrors,
  hasRemoteProjectFieldErrors,
  type RemoteProjectFieldErrors,
  withoutRemoteProjectFieldError,
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
  const [remoteProjectDialogMode, setRemoteProjectDialogMode] = useState<"add" | "edit">("add");
  const [editingProjectId, setEditingProjectId] = useState<ProjectId | null>(null);
  const [editingProjectUpdatedAt, setEditingProjectUpdatedAt] = useState<string | null>(null);
  const [remoteAgentInstallRequest, setRemoteAgentInstallRequest] =
    useState<SidebarRemoteAgentInstallRequest | null>(null);
  const verificationRequestIdRef = useRef(0);
  const unlock = useRemoteProjectUnlock({
    draft: remoteProjectDraft,
    setDialogError: setRemoteProjectError,
  });
  const { dismiss: dismissUnlock, reset: resetUnlock, request: requestUnlock } = unlock;

  const resetRemoteProjectDialog = useCallback(() => {
    setIsRemoteProjectDialogOpen(false);
    setRemoteProjectDraft(createDefaultRemoteProjectDraft());
    setRemoteProjectFieldErrors({});
    setRemoteProjectError(null);
    setRemoteProjectVerificationMessage(null);
    setIsVerifyingRemoteProject(false);
    setIsSavingRemoteProject(false);
    resetUnlock();
    setRemoteProjectDialogMode("add");
    setEditingProjectId(null);
    setEditingProjectUpdatedAt(null);
    setRemoteAgentInstallRequest(null);
    verificationRequestIdRef.current += 1;
  }, [resetUnlock]);

  const openRemoteProjectDialog = useCallback(() => {
    setRemoteProjectDialogMode("add");
    setEditingProjectId(null);
    setEditingProjectUpdatedAt(null);
    setRemoteProjectDraft(createDefaultRemoteProjectDraft(readLastRemoteProjectConnectionSource()));
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
    if (isAddingProject || isSavingRemoteProject || unlock.isUnlocking) {
      return;
    }
    resetRemoteProjectDialog();
  }, [isAddingProject, isSavingRemoteProject, unlock.isUnlocking, resetRemoteProjectDialog]);

  const updateRemoteProjectDraft = useCallback(
    <K extends RemoteProjectDraftField>(field: K, value: RemoteProjectDraft[K]) => {
      verificationRequestIdRef.current += 1;
      setRemoteProjectDraft((current) => applyRemoteProjectDraftChange(current, field, value));
      setRemoteProjectError(null);
      setRemoteProjectVerificationMessage(null);
      dismissUnlock();
      setRemoteProjectFieldErrors((current) => withoutRemoteProjectFieldError(current, field));
    },
    [dismissUnlock],
  );

  /** Edit-mode inference only: same target, so in-flight verification stays valid. */
  const adoptRemoteProjectConnectionSource = useCallback(
    (source: RemoteProjectConnectionSource) => {
      setRemoteProjectDraft((current) =>
        applyRemoteProjectDraftChange(current, "connectionSource", source),
      );
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
      setRemoteProjectVerificationMessage(null);
      if (requestUnlock(errorMessage)) {
        return "unlock-required" as const;
      }
      setRemoteProjectError(errorMessage);
      return "invalid" as const;
    } finally {
      if (requestId === verificationRequestIdRef.current) {
        setIsVerifyingRemoteProject(false);
      }
    }
  }, [remoteProjectDraft, requestUnlock]);

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

  const submitRemoteProjectUnlock = useCallback(
    () =>
      unlock.submit(async () => {
        if ((await verifyRemoteProjectDialog()) === "verified") {
          await submitRemoteProject(remoteProjectDraft);
        }
      }),
    [remoteProjectDraft, submitRemoteProject, unlock, verifyRemoteProjectDialog],
  );

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
    adoptRemoteProjectConnectionSource,
    requestRemoteProjectUnlock: requestUnlock,
    submitRemoteProjectDialog,
    remoteAgentInstallRequest,
    declineRemoteAgentInstall,
    completeRemoteAgentInstall,
    isRemoteProjectUnlockDialogOpen: unlock.isOpen,
    remoteProjectUnlockMode: unlock.mode,
    remoteProjectUnlockKeyPath: unlock.keyPath,
    remoteProjectUnlockPassphrase: unlock.passphrase,
    remoteProjectUnlockError: unlock.error,
    isUnlockingRemoteProjectKey: unlock.isUnlocking,
    closeRemoteProjectUnlockDialog: unlock.close,
    setRemoteProjectUnlockPassphrase: unlock.setPassphrase,
    submitRemoteProjectUnlock,
  };
}
