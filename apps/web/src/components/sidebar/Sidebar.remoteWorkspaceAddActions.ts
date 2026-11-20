import { useCallback, useRef, useState } from "react";

import type { ProjectId } from "@bigbud/contracts";
import { readNativeApi } from "../../rpc/nativeApi";
import { connectExecutionTargetForSetup } from "../../stores/remoteAccess/remoteAccess.connect";
import {
  applyRemoteWorkspaceDraftChange,
  createDefaultRemoteWorkspaceDraft,
  createRemoteWorkspaceDraft,
  createRemoteWorkspaceExecutionTargetId,
  getRemoteWorkspaceConnectionLabel,
  type RemoteWorkspaceConnectionSource,
  type RemoteWorkspaceDraft,
  type RemoteWorkspaceDraftField,
} from "./Sidebar.remoteWorkspaces.logic";
import { readLastRemoteWorkspaceConnectionSource } from "./Sidebar.remoteWorkspaces.connectionSourcePreference";
import type { Project } from "../../models/types";
import { useRemoteWorkspaceSubmit } from "./Sidebar.remoteWorkspaceAddActions.submit";
import { useRemoteWorkspaceUnlock } from "./Sidebar.remoteWorkspaceAddActions.unlock";
import {
  createRemoteWorkspaceFieldErrors,
  hasRemoteWorkspaceFieldErrors,
  type RemoteWorkspaceFieldErrors,
  withoutRemoteWorkspaceFieldError,
} from "./Sidebar.projectAddActions.helpers";
import type {
  SidebarRemoteWorkspaceAddActionsOutput,
  UseSidebarRemoteWorkspaceAddActionsInput,
} from "./Sidebar.remoteWorkspaceAddActions.types";
import {
  installAndConnectRemoteAgent,
  remoteAgentNeedsInstallOnSave,
  type RemoteAgentInstallProgress,
} from "./Sidebar.remoteWorkspaceAgentInstall";
import { toastManager } from "../ui/toast.manager";

export function useSidebarRemoteWorkspaceAddActions({
  createProject,
  isAddingProject,
}: UseSidebarRemoteWorkspaceAddActionsInput): SidebarRemoteWorkspaceAddActionsOutput {
  const [isRemoteWorkspaceDialogOpen, setIsRemoteWorkspaceDialogOpen] = useState(false);
  const [remoteWorkspaceDraft, setRemoteWorkspaceDraft] = useState<RemoteWorkspaceDraft>(
    createDefaultRemoteWorkspaceDraft,
  );
  const [remoteWorkspaceFieldErrors, setRemoteWorkspaceFieldErrors] =
    useState<RemoteWorkspaceFieldErrors>({});
  const [remoteWorkspaceError, setRemoteWorkspaceError] = useState<string | null>(null);
  const [remoteWorkspaceVerificationMessage, setRemoteWorkspaceVerificationMessage] = useState<
    string | null
  >(null);
  const [isVerifyingRemoteWorkspace, setIsVerifyingRemoteWorkspace] = useState(false);
  const [isSavingRemoteWorkspace, setIsSavingRemoteWorkspace] = useState(false);
  const [remoteWorkspaceDialogMode, setRemoteWorkspaceDialogMode] = useState<"add" | "edit">("add");
  const [editingProjectId, setEditingProjectId] = useState<ProjectId | null>(null);
  const [editingProjectUpdatedAt, setEditingProjectUpdatedAt] = useState<string | null>(null);
  const [remoteAgentInstallProgress, setRemoteAgentInstallProgress] =
    useState<RemoteAgentInstallProgress | null>(null);
  const [remoteAgentManualInstallTarget, setRemoteAgentManualInstallTarget] = useState<
    string | null
  >(null);
  const verificationRequestIdRef = useRef(0);
  const unlock = useRemoteWorkspaceUnlock({
    draft: remoteWorkspaceDraft,
    setDialogError: setRemoteWorkspaceError,
  });
  const { dismiss: dismissUnlock, reset: resetUnlock, request: requestUnlock } = unlock;

  const resetRemoteWorkspaceDialog = useCallback(() => {
    setIsRemoteWorkspaceDialogOpen(false);
    setRemoteWorkspaceDraft(createDefaultRemoteWorkspaceDraft());
    setRemoteWorkspaceFieldErrors({});
    setRemoteWorkspaceError(null);
    setRemoteWorkspaceVerificationMessage(null);
    setIsVerifyingRemoteWorkspace(false);
    setIsSavingRemoteWorkspace(false);
    resetUnlock();
    setRemoteWorkspaceDialogMode("add");
    setEditingProjectId(null);
    setEditingProjectUpdatedAt(null);
    setRemoteAgentInstallProgress(null);
    setRemoteAgentManualInstallTarget(null);
    verificationRequestIdRef.current += 1;
  }, [resetUnlock]);

  const openRemoteWorkspaceDialog = useCallback(() => {
    setRemoteWorkspaceDialogMode("add");
    setEditingProjectId(null);
    setEditingProjectUpdatedAt(null);
    setRemoteWorkspaceDraft(
      createDefaultRemoteWorkspaceDraft(readLastRemoteWorkspaceConnectionSource()),
    );
    setIsRemoteWorkspaceDialogOpen(true);
    setRemoteWorkspaceFieldErrors({});
    setRemoteWorkspaceError(null);
  }, []);

  const openRemoteWorkspaceEditDialog = useCallback((project: Project) => {
    const draft = createRemoteWorkspaceDraft(project);
    if (!draft) {
      return;
    }
    verificationRequestIdRef.current += 1;
    setRemoteWorkspaceDialogMode("edit");
    setEditingProjectId(project.id);
    setEditingProjectUpdatedAt(project.updatedAt ?? null);
    setRemoteWorkspaceDraft(draft);
    setRemoteWorkspaceFieldErrors({});
    setRemoteWorkspaceError(null);
    setRemoteWorkspaceVerificationMessage(null);
    setIsRemoteWorkspaceDialogOpen(true);
  }, []);

  const closeRemoteWorkspaceDialog = useCallback(() => {
    if (isAddingProject || isSavingRemoteWorkspace || unlock.isUnlocking) {
      return;
    }
    resetRemoteWorkspaceDialog();
  }, [isAddingProject, isSavingRemoteWorkspace, unlock.isUnlocking, resetRemoteWorkspaceDialog]);

  const updateRemoteWorkspaceDraft = useCallback(
    <K extends RemoteWorkspaceDraftField>(field: K, value: RemoteWorkspaceDraft[K]) => {
      verificationRequestIdRef.current += 1;
      setRemoteWorkspaceDraft((current) => applyRemoteWorkspaceDraftChange(current, field, value));
      setRemoteWorkspaceError(null);
      setRemoteWorkspaceVerificationMessage(null);
      setRemoteAgentManualInstallTarget(null);
      dismissUnlock();
      setRemoteWorkspaceFieldErrors((current) => withoutRemoteWorkspaceFieldError(current, field));
    },
    [dismissUnlock],
  );

  /** Edit-mode inference only: same target, so in-flight verification stays valid. */
  const adoptRemoteWorkspaceConnectionSource = useCallback(
    (source: RemoteWorkspaceConnectionSource) => {
      setRemoteWorkspaceDraft((current) =>
        applyRemoteWorkspaceDraftChange(current, "connectionSource", source),
      );
    },
    [],
  );

  const verifyRemoteWorkspaceDialog = useCallback(async () => {
    const requestId = ++verificationRequestIdRef.current;
    const nextErrors = createRemoteWorkspaceFieldErrors(remoteWorkspaceDraft);
    setRemoteWorkspaceFieldErrors(nextErrors);

    if (hasRemoteWorkspaceFieldErrors(nextErrors)) {
      setRemoteWorkspaceError("Fix the highlighted fields before verifying the connection.");
      setRemoteWorkspaceVerificationMessage(null);
      return "invalid" as const;
    }

    const api = readNativeApi();
    if (!api) {
      setRemoteWorkspaceError("Native API not found.");
      setRemoteWorkspaceVerificationMessage(null);
      return "invalid" as const;
    }

    setIsVerifyingRemoteWorkspace(true);
    setRemoteWorkspaceError(null);
    setRemoteAgentManualInstallTarget(null);
    const executionTargetId = createRemoteWorkspaceExecutionTargetId(remoteWorkspaceDraft);
    try {
      await connectExecutionTargetForSetup(api, executionTargetId);
      const result = await api.server.verifyExecutionTarget({
        executionTargetId,
        cwd: remoteWorkspaceDraft.workspaceRoot.trim(),
      });
      if (requestId !== verificationRequestIdRef.current) {
        return "invalid" as const;
      }
      const verification = result.remoteAgent;
      if (!(await remoteAgentNeedsInstallOnSave({ api, executionTargetId, verification }))) {
        setRemoteWorkspaceVerificationMessage(result.message);
        return "verified" as const;
      }
      // Save installs or replaces the agent inline, with no confirmation dialog (D8).
      setRemoteWorkspaceVerificationMessage(null);
      try {
        const installed = await installAndConnectRemoteAgent({
          api,
          executionTargetId,
          onProgress: (progress) => {
            if (requestId === verificationRequestIdRef.current)
              setRemoteAgentInstallProgress(progress);
          },
        });
        if (requestId !== verificationRequestIdRef.current) return "invalid" as const;
        const message = [installed.message, installed.cleanupMessage].filter(Boolean).join(" ");
        setRemoteWorkspaceVerificationMessage(message);
        toastManager.add({
          type: installed.warning ? "warning" : "success",
          title: `Remote agent ready on ${getRemoteWorkspaceConnectionLabel(remoteWorkspaceDraft)}`,
          description: message,
        });
        return "verified" as const;
      } catch (cause) {
        if (requestId !== verificationRequestIdRef.current) return "invalid" as const;
        setRemoteWorkspaceError(
          cause instanceof Error ? cause.message : "Failed to install the remote agent.",
        );
        setRemoteAgentManualInstallTarget(executionTargetId);
        return "invalid" as const;
      } finally {
        if (requestId === verificationRequestIdRef.current) setRemoteAgentInstallProgress(null);
      }
    } catch (error) {
      if (requestId !== verificationRequestIdRef.current) {
        return "invalid" as const;
      }
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to verify the SSH connection for this remote workspace.";
      setRemoteWorkspaceVerificationMessage(null);
      if (requestUnlock(errorMessage)) {
        return "unlock-required" as const;
      }
      setRemoteWorkspaceError(errorMessage);
      return "invalid" as const;
    } finally {
      if (requestId === verificationRequestIdRef.current) {
        setIsVerifyingRemoteWorkspace(false);
      }
    }
  }, [remoteWorkspaceDraft, requestUnlock]);

  const submitRemoteWorkspace = useRemoteWorkspaceSubmit({
    createProject,
    dialogMode: remoteWorkspaceDialogMode,
    editingProjectId,
    editingProjectUpdatedAt,
    resetDialog: resetRemoteWorkspaceDialog,
    setError: setRemoteWorkspaceError,
    setSaving: setIsSavingRemoteWorkspace,
  });

  const submitRemoteWorkspaceDialog = useCallback(async () => {
    if (isSavingRemoteWorkspace || isVerifyingRemoteWorkspace) {
      return;
    }
    setRemoteWorkspaceError(null);
    const candidate = remoteWorkspaceDraft;
    const requestId = verificationRequestIdRef.current + 1;
    const verificationState = await verifyRemoteWorkspaceDialog();
    if (verificationState !== "verified" || requestId !== verificationRequestIdRef.current) {
      return;
    }

    await submitRemoteWorkspace(candidate);
  }, [
    isSavingRemoteWorkspace,
    isVerifyingRemoteWorkspace,
    remoteWorkspaceDraft,
    submitRemoteWorkspace,
    verifyRemoteWorkspaceDialog,
  ]);

  const submitRemoteWorkspaceUnlock = useCallback(
    () =>
      unlock.submit(async () => {
        if ((await verifyRemoteWorkspaceDialog()) === "verified") {
          await submitRemoteWorkspace(remoteWorkspaceDraft);
        }
      }),
    [remoteWorkspaceDraft, submitRemoteWorkspace, unlock, verifyRemoteWorkspaceDialog],
  );

  return {
    remoteWorkspaceDialogMode,
    isRemoteWorkspaceDialogOpen,
    remoteWorkspaceDraft,
    remoteWorkspaceFieldErrors,
    remoteWorkspaceError,
    remoteWorkspaceVerificationMessage,
    isVerifyingRemoteWorkspace,
    isSavingRemoteWorkspace,
    openRemoteWorkspaceDialog,
    openRemoteWorkspaceEditDialog,
    closeRemoteWorkspaceDialog,
    updateRemoteWorkspaceDraft,
    adoptRemoteWorkspaceConnectionSource,
    requestRemoteWorkspaceUnlock: requestUnlock,
    submitRemoteWorkspaceDialog,
    remoteAgentInstallProgress,
    remoteAgentManualInstallTarget,
    isRemoteWorkspaceUnlockDialogOpen: unlock.isOpen,
    remoteWorkspaceUnlockMode: unlock.mode,
    remoteWorkspaceUnlockKeyPath: unlock.keyPath,
    remoteWorkspaceUnlockPassphrase: unlock.passphrase,
    remoteWorkspaceUnlockError: unlock.error,
    isUnlockingRemoteWorkspaceKey: unlock.isUnlocking,
    closeRemoteWorkspaceUnlockDialog: unlock.close,
    setRemoteWorkspaceUnlockPassphrase: unlock.setPassphrase,
    submitRemoteWorkspaceUnlock,
  };
}
