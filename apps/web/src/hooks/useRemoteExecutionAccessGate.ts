import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  type RemoteExecutionAuthMode,
  useRemoteAccessStore,
} from "../stores/remoteAccess/remoteAccess.store";
import { submitRemoteExecutionAuth as submitAuth } from "./useRemoteExecutionAccessGate.auth";
import {
  beginRemoteExecutionTargetAccessCheck,
  type EnsureRemoteExecutionTargetAccessInput,
  ensureRemoteExecutionTargetAccess,
} from "./useRemoteExecutionAccessGate.access";

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

/** Submits the global auth dialog; a non-auth failure offers Retry through the access check. */
export async function submitPendingRemoteExecutionAuth(): Promise<void> {
  const pending = useRemoteAccessStore.getState().pendingAction;
  await submitAuth(() => {
    if (pending)
      void beginRemoteExecutionTargetAccessCheck({ ...pending, resumeOnUnlockOnly: false });
  });
}

export function useRemoteExecutionAccessGate(): RemoteExecutionAccessGate {
  const {
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

  // Identity follows the checks (as before the module split), so callers that captured a gate
  // callback re-render when access changes; the functions themselves always read live state.
  const begin = useCallback(
    (input: EnsureRemoteExecutionTargetAccessInput) => beginRemoteExecutionTargetAccessCheck(input),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [executionTargetChecks],
  );
  const ensure = useCallback(
    (input: EnsureRemoteExecutionTargetAccessInput) => ensureRemoteExecutionTargetAccess(input),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [executionTargetChecks],
  );

  const closeRemoteExecutionAuthDialog = useCallback(() => {
    if (isAuthenticatingRemoteExecution) {
      return;
    }
    closeAuthDialog();
  }, [closeAuthDialog, isAuthenticatingRemoteExecution]);

  return {
    beginRemoteExecutionTargetAccessCheck: begin,
    ensureRemoteExecutionTargetAccess: ensure,
    isRemoteExecutionAuthDialogOpen,
    remoteExecutionAuthMode,
    remoteExecutionAuthPromptLabel,
    remoteExecutionAuthSecret,
    remoteExecutionAuthError,
    isAuthenticatingRemoteExecution,
    closeRemoteExecutionAuthDialog,
    setRemoteExecutionAuthSecret,
    submitRemoteExecutionAuth: submitPendingRemoteExecutionAuth,
  };
}
