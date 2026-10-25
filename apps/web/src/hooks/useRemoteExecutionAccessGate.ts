import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";

import { isRemoteExecutionTargetId } from "../components/sidebar/Sidebar.projects.logic";
import { toastManager } from "../components/ui/toast";
import {
  type RemoteExecutionAuthMode,
  useRemoteAccessStore,
} from "../stores/remoteAccess/remoteAccess.store";
import {
  REMOTE_EXECUTION_FOREGROUND_TIMEOUT_MS,
  resolveRemoteExecutionFailureStatus,
} from "./useRemoteExecutionAccessGate.shared";
import {
  ensureBackgroundRemoteExecutionToast,
  readRemoteExecutionCheck,
  showRemoteExecutionFailureToast,
  startRemoteExecutionCheck,
} from "./useRemoteExecutionAccessGate.checks";
import { verifyRemoteExecutionTarget } from "./useRemoteExecutionAccessGate.verification";
import { submitRemoteExecutionAuth as submitAuth } from "./useRemoteExecutionAccessGate.auth";

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
}): boolean {
  if (!input.onVerified) {
    return false;
  }
  return useRemoteAccessStore.getState().openAuthDialog({
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
    isRemoteExecutionAuthDialogOpen,
    remoteExecutionAuthMode,
    remoteExecutionAuthPromptLabel,
    remoteExecutionAuthSecret,
    remoteExecutionAuthError,
    isAuthenticatingRemoteExecution,
    closeAuthDialog,
    setRemoteExecutionAuthSecret,
  } = useRemoteAccessStore(
    useShallow((state) => ({
      verifiedExecutionTargetIds: state.verifiedExecutionTargetIds,
      executionTargetChecks: state.executionTargetChecks,
      isRemoteExecutionAuthDialogOpen: state.isAuthDialogOpen,
      remoteExecutionAuthMode: state.authMode,
      remoteExecutionAuthPromptLabel: state.authPromptLabel,
      remoteExecutionAuthSecret: state.authSecret,
      remoteExecutionAuthError: state.authError,
      isAuthenticatingRemoteExecution: state.isAuthenticating,
      closeAuthDialog: state.closeAuthDialog,
      setRemoteExecutionAuthSecret: state.setAuthSecret,
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
        const opened = openRemoteExecutionAuthDialog({
          executionTargetId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.onVerified ? { onVerified: input.onVerified } : {}),
          ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
          authMode: check.authMode,
          promptLabel: check.promptLabel,
        });
        if (!opened) {
          toastManager.add({
            type: "warning",
            title: "Another remote authentication request is already pending.",
          });
        }
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
        const opened = openRemoteExecutionAuthDialog({
          executionTargetId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.onVerified ? { onVerified: input.onVerified } : {}),
          ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
          authMode: check.authMode,
          promptLabel: check.promptLabel,
        });
        if (!opened) {
          toastManager.add({
            type: "warning",
            title: "Another remote authentication request is already pending.",
          });
        }
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
    const pending = useRemoteAccessStore.getState().pendingAction;
    await submitAuth(() => {
      if (pending)
        void beginRemoteExecutionTargetAccessCheck({ ...pending, resumeOnUnlockOnly: false });
    });
  }, [beginRemoteExecutionTargetAccessCheck]);

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
