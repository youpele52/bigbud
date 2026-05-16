import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";

import { readNativeApi } from "../rpc/nativeApi";
import { getPassphraseProtectedSshKeyPath, getPasswordProtectedSshTargetLabel } from "../lib/ssh";
import { toastManager } from "../components/ui/toast";
import {
  type RemoteExecutionAuthMode,
  useRemoteAccessStore,
} from "../stores/remoteAccess/remoteAccess.store";
import { isRemoteExecutionTargetId } from "../components/sidebar/Sidebar.projects.logic";

interface EnsureRemoteExecutionTargetAccessInput {
  readonly executionTargetId: string | null | undefined;
  readonly cwd?: string;
  readonly unavailableTitle?: string;
  readonly onVerified?: () => Promise<void> | void;
  readonly resumeOnUnlockOnly?: boolean;
}

export interface RemoteExecutionAccessGate {
  readonly ensureRemoteExecutionTargetAccess: (
    input: EnsureRemoteExecutionTargetAccessInput,
  ) => Promise<boolean>;
  readonly isRemoteExecutionAuthDialogOpen: boolean;
  readonly remoteExecutionAuthMode: RemoteExecutionAuthMode | null;
  readonly remoteExecutionAuthPromptLabel: string;
  readonly remoteExecutionAuthSecret: string;
  readonly remoteExecutionAuthError: string | null;
  readonly isAuthenticatingRemoteExecution: boolean;
  readonly closeRemoteExecutionAuthDialog: () => void;
  readonly setRemoteExecutionAuthSecret: (secret: string) => void;
  readonly submitRemoteExecutionAuth: () => Promise<void>;
}

async function verifyRemoteExecutionTarget(input: {
  readonly executionTargetId: string;
  readonly cwd?: string;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found.");
  }

  await api.server.verifyExecutionTarget({
    executionTargetId: input.executionTargetId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
}

function resolveRemoteExecutionAuthRequirement(errorMessage: string): {
  authMode: RemoteExecutionAuthMode;
  promptLabel: string;
} | null {
  const keyPath = getPassphraseProtectedSshKeyPath(errorMessage);
  if (keyPath) {
    return {
      authMode: "ssh-key-passphrase",
      promptLabel: keyPath,
    };
  }

  const targetLabel = getPasswordProtectedSshTargetLabel(errorMessage);
  if (targetLabel) {
    return {
      authMode: "password",
      promptLabel: targetLabel,
    };
  }

  return null;
}

export function useRemoteExecutionAccessGate(): RemoteExecutionAccessGate {
  const {
    verifiedExecutionTargetIds,
    pendingAction,
    isRemoteExecutionAuthDialogOpen,
    remoteExecutionAuthMode,
    remoteExecutionAuthPromptLabel,
    remoteExecutionAuthSecret,
    remoteExecutionAuthError,
    isAuthenticatingRemoteExecution,
    markExecutionTargetVerified,
    openAuthDialog,
    closeAuthDialog,
    setRemoteExecutionAuthSecret,
    setRemoteExecutionAuthError,
    setIsAuthenticatingRemoteExecution,
  } = useRemoteAccessStore(
    useShallow((state) => ({
      verifiedExecutionTargetIds: state.verifiedExecutionTargetIds,
      pendingAction: state.pendingAction,
      isRemoteExecutionAuthDialogOpen: state.isAuthDialogOpen,
      remoteExecutionAuthMode: state.authMode,
      remoteExecutionAuthPromptLabel: state.authPromptLabel,
      remoteExecutionAuthSecret: state.authSecret,
      remoteExecutionAuthError: state.authError,
      isAuthenticatingRemoteExecution: state.isAuthenticating,
      markExecutionTargetVerified: state.markExecutionTargetVerified,
      openAuthDialog: state.openAuthDialog,
      closeAuthDialog: state.closeAuthDialog,
      setRemoteExecutionAuthSecret: state.setAuthSecret,
      setRemoteExecutionAuthError: state.setAuthError,
      setIsAuthenticatingRemoteExecution: state.setIsAuthenticating,
    })),
  );

  const ensureRemoteExecutionTargetAccess = useCallback(
    async (input: EnsureRemoteExecutionTargetAccessInput) => {
      if (!input.executionTargetId || !isRemoteExecutionTargetId(input.executionTargetId)) {
        if (!input.resumeOnUnlockOnly) {
          await input.onVerified?.();
        }
        return true;
      }
      const executionTargetId = input.executionTargetId;

      if (verifiedExecutionTargetIds[executionTargetId]) {
        if (!input.resumeOnUnlockOnly) {
          await input.onVerified?.();
        }
        return true;
      }

      try {
        await verifyRemoteExecutionTarget({
          executionTargetId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        });
        markExecutionTargetVerified(executionTargetId);
        if (!input.resumeOnUnlockOnly) {
          await input.onVerified?.();
        }
        return true;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to reconnect to the remote project.";
        const requirement = resolveRemoteExecutionAuthRequirement(errorMessage);
        if (requirement) {
          if (!input.onVerified) {
            throw error;
          }
          openAuthDialog({
            pendingAction: {
              executionTargetId,
              ...(input.cwd ? { cwd: input.cwd } : {}),
              onVerified: input.onVerified,
              ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
            },
            authMode: requirement.authMode,
            promptLabel: requirement.promptLabel,
          });
          return false;
        }

        toastManager.add({
          type: "error",
          title: input.unavailableTitle ?? "Remote project unavailable",
          description: errorMessage,
        });
        return false;
      }
    },
    [markExecutionTargetVerified, openAuthDialog, verifiedExecutionTargetIds],
  );

  const submitRemoteExecutionAuth = useCallback(async () => {
    const secret = remoteExecutionAuthSecret.trim();
    if (secret.length === 0) {
      setRemoteExecutionAuthError(
        remoteExecutionAuthMode === "password"
          ? "Enter the SSH password."
          : "Enter the SSH key passphrase.",
      );
      return;
    }

    if (!pendingAction || !remoteExecutionAuthMode) {
      setRemoteExecutionAuthError(
        "Remote access context was lost. Try opening the remote project again.",
      );
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setRemoteExecutionAuthError("Native API not found.");
      return;
    }

    setIsAuthenticatingRemoteExecution(true);
    setRemoteExecutionAuthError(null);
    try {
      if (remoteExecutionAuthMode === "password") {
        await api.server.unlockSshPassword({
          executionTargetId: pendingAction.executionTargetId,
          password: secret,
        });
      } else {
        await api.server.unlockSshKey({
          executionTargetId: pendingAction.executionTargetId,
          passphrase: secret,
        });
      }
      await verifyRemoteExecutionTarget({
        executionTargetId: pendingAction.executionTargetId,
        ...(pendingAction.cwd ? { cwd: pendingAction.cwd } : {}),
      });
      markExecutionTargetVerified(pendingAction.executionTargetId);
      closeAuthDialog();
      await pendingAction.onVerified();
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : remoteExecutionAuthMode === "password"
            ? "Failed to unlock the SSH password session."
            : "Failed to unlock the SSH key.";
      const requirement = resolveRemoteExecutionAuthRequirement(errorMessage);
      if (requirement && requirement.authMode === remoteExecutionAuthMode) {
        setRemoteExecutionAuthError(errorMessage);
        return;
      }

      closeAuthDialog();
      toastManager.add({
        type: "error",
        title: pendingAction.unavailableTitle ?? "Remote project unavailable",
        description: errorMessage,
      });
    } finally {
      setIsAuthenticatingRemoteExecution(false);
    }
  }, [
    closeAuthDialog,
    markExecutionTargetVerified,
    pendingAction,
    remoteExecutionAuthMode,
    remoteExecutionAuthSecret,
    setIsAuthenticatingRemoteExecution,
    setRemoteExecutionAuthError,
  ]);

  const closeRemoteExecutionAuthDialog = useCallback(() => {
    if (isAuthenticatingRemoteExecution) {
      return;
    }
    closeAuthDialog();
  }, [closeAuthDialog, isAuthenticatingRemoteExecution]);

  return {
    ensureRemoteExecutionTargetAccess,
    isRemoteExecutionAuthDialogOpen,
    remoteExecutionAuthMode,
    remoteExecutionAuthPromptLabel,
    remoteExecutionAuthSecret,
    remoteExecutionAuthError,
    isAuthenticatingRemoteExecution,
    closeRemoteExecutionAuthDialog,
    setRemoteExecutionAuthSecret,
    submitRemoteExecutionAuth,
  };
}
