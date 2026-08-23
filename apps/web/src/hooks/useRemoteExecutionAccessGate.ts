import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";

import { isRemoteExecutionTargetId } from "../components/sidebar/Sidebar.projects.logic";
import { readNativeApi } from "../rpc/nativeApi";
import {
  type RemoteExecutionAuthMode,
  useRemoteAccessStore,
} from "../stores/remoteAccess/remoteAccess.store";
import {
  REMOTE_EXECUTION_FOREGROUND_TIMEOUT_MS,
  resolveRemoteExecutionCheckingStatus,
  resolveRemoteExecutionFailureStatus,
} from "./useRemoteExecutionAccessGate.shared";
import {
  ensureBackgroundRemoteExecutionToast,
  readRemoteExecutionCheck,
  showRemoteExecutionFailureToast,
  startRemoteExecutionCheck,
} from "./useRemoteExecutionAccessGate.checks";

interface EnsureRemoteExecutionTargetAccessInput {
  readonly executionTargetId: string | null | undefined;
  readonly cwd?: string;
  readonly unavailableTitle?: string;
  readonly onVerified?: () => Promise<void> | void;
  readonly resumeOnUnlockOnly?: boolean;
}

export interface RemoteExecutionAccessGate {
  readonly beginRemoteExecutionTargetAccessCheck: (
    input: EnsureRemoteExecutionTargetAccessInput,
  ) => Promise<boolean>;
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

  const result = await api.server.verifyExecutionTarget({
    executionTargetId: input.executionTargetId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  if (result.remoteAgent?.status === "install-required") {
    throw new Error(
      "The bigbud remote agent is not installed. Edit the remote project to review and approve installation.",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function openRemoteExecutionAuthDialog(input: {
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly onVerified?: () => Promise<void> | void;
  readonly unavailableTitle?: string;
  readonly authMode: RemoteExecutionAuthMode;
  readonly promptLabel: string;
}) {
  if (!input.onVerified) {
    return;
  }
  useRemoteAccessStore.getState().openAuthDialog({
    pendingAction: {
      executionTargetId: input.executionTargetId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      onVerified: input.onVerified,
      ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
    },
    authMode: input.authMode,
    promptLabel: input.promptLabel,
  });
}

export function useRemoteExecutionAccessGate(): RemoteExecutionAccessGate {
  const {
    verifiedExecutionTargetIds,
    executionTargetChecks,
    pendingAction,
    isRemoteExecutionAuthDialogOpen,
    remoteExecutionAuthMode,
    remoteExecutionAuthPromptLabel,
    remoteExecutionAuthSecret,
    remoteExecutionAuthError,
    isAuthenticatingRemoteExecution,
    markExecutionTargetVerified,
    setExecutionTargetCheck,
    closeAuthDialog,
    setRemoteExecutionAuthSecret,
    setRemoteExecutionAuthError,
    setIsAuthenticatingRemoteExecution,
  } = useRemoteAccessStore(
    useShallow((state) => ({
      verifiedExecutionTargetIds: state.verifiedExecutionTargetIds,
      executionTargetChecks: state.executionTargetChecks,
      pendingAction: state.pendingAction,
      isRemoteExecutionAuthDialogOpen: state.isAuthDialogOpen,
      remoteExecutionAuthMode: state.authMode,
      remoteExecutionAuthPromptLabel: state.authPromptLabel,
      remoteExecutionAuthSecret: state.authSecret,
      remoteExecutionAuthError: state.authError,
      isAuthenticatingRemoteExecution: state.isAuthenticating,
      markExecutionTargetVerified: state.markExecutionTargetVerified,
      setExecutionTargetCheck: state.setExecutionTargetCheck,
      closeAuthDialog: state.closeAuthDialog,
      setRemoteExecutionAuthSecret: state.setAuthSecret,
      setRemoteExecutionAuthError: state.setAuthError,
      setIsAuthenticatingRemoteExecution: state.setIsAuthenticating,
    })),
  );

  const beginRemoteExecutionTargetAccessCheck = useCallback(
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

      const activeCheck = startRemoteExecutionCheck({
        executionTargetId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
        verify: verifyRemoteExecutionTarget,
      });
      const outcome = await Promise.race([
        activeCheck.promise.then(() => "settled" as const),
        sleep(REMOTE_EXECUTION_FOREGROUND_TIMEOUT_MS).then(() => "timeout" as const),
      ]);
      const check =
        executionTargetChecks[executionTargetId] ?? readRemoteExecutionCheck(executionTargetId);

      if (outcome === "timeout") {
        ensureBackgroundRemoteExecutionToast({
          executionTargetId,
          ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
        });
        if (!input.resumeOnUnlockOnly) {
          await input.onVerified?.();
        }
        return true;
      }

      if (check?.status === "verified") {
        if (!input.resumeOnUnlockOnly) {
          await input.onVerified?.();
        }
        return true;
      }

      if (
        check?.status === "auth_required" &&
        check.authMode !== null &&
        check.promptLabel !== null
      ) {
        openRemoteExecutionAuthDialog({
          executionTargetId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.onVerified ? { onVerified: input.onVerified } : {}),
          ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
          authMode: check.authMode,
          promptLabel: check.promptLabel,
        });
        return false;
      }

      showRemoteExecutionFailureToast({
        executionTargetId,
        ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
        check:
          check ??
          resolveRemoteExecutionFailureStatus("Failed to reconnect to the remote project."),
        retry: () => {
          void beginRemoteExecutionTargetAccessCheck({ ...input, resumeOnUnlockOnly: false });
        },
      });
      return false;
    },
    [executionTargetChecks, verifiedExecutionTargetIds],
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

      const check = executionTargetChecks[executionTargetId];
      if (
        check?.status === "auth_required" &&
        check.authMode !== null &&
        check.promptLabel !== null
      ) {
        openRemoteExecutionAuthDialog({
          executionTargetId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.onVerified ? { onVerified: input.onVerified } : {}),
          ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
          authMode: check.authMode,
          promptLabel: check.promptLabel,
        });
        return false;
      }
      if (check?.status === "error") {
        showRemoteExecutionFailureToast({
          executionTargetId,
          ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
          check,
          retry: () => {
            void beginRemoteExecutionTargetAccessCheck({ ...input, resumeOnUnlockOnly: false });
          },
        });
        return false;
      }

      if (check?.status !== "checking") {
        startRemoteExecutionCheck({
          executionTargetId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
          verify: verifyRemoteExecutionTarget,
        });
      }
      if (!input.resumeOnUnlockOnly) {
        await input.onVerified?.();
      }
      return true;
    },
    [beginRemoteExecutionTargetAccessCheck, executionTargetChecks, verifiedExecutionTargetIds],
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
      setExecutionTargetCheck(
        pendingAction.executionTargetId,
        resolveRemoteExecutionCheckingStatus(),
      );
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
      const failureStatus = resolveRemoteExecutionFailureStatus(errorMessage);
      setExecutionTargetCheck(pendingAction.executionTargetId, failureStatus);
      if (failureStatus.status === "auth_required") {
        setRemoteExecutionAuthError(errorMessage);
        return;
      }

      closeAuthDialog();
      showRemoteExecutionFailureToast({
        executionTargetId: pendingAction.executionTargetId,
        ...(pendingAction.unavailableTitle
          ? { unavailableTitle: pendingAction.unavailableTitle }
          : {}),
        check: failureStatus,
        retry: () => {
          void beginRemoteExecutionTargetAccessCheck({
            ...pendingAction,
            resumeOnUnlockOnly: false,
          });
        },
      });
    } finally {
      setIsAuthenticatingRemoteExecution(false);
    }
  }, [
    beginRemoteExecutionTargetAccessCheck,
    closeAuthDialog,
    markExecutionTargetVerified,
    pendingAction,
    remoteExecutionAuthMode,
    remoteExecutionAuthSecret,
    setExecutionTargetCheck,
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
    beginRemoteExecutionTargetAccessCheck,
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
