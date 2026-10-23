import { submitSshAuthentication } from "../lib/ssh.auth";
import { useRemoteAccessStore } from "../stores/remoteAccess/remoteAccess.store";
import {
  resolveRemoteExecutionCheckingStatus,
  resolveRemoteExecutionFailureStatus,
} from "./useRemoteExecutionAccessGate.shared";
import { showRemoteExecutionFailureToast } from "./useRemoteExecutionAccessGate.checks";
import { verifyRemoteExecutionTarget } from "./useRemoteExecutionAccessGate.verification";

/** Continues the same pending action through host trust, then password/key authentication. */
export async function submitRemoteExecutionAuth(retry: () => void): Promise<void> {
  const state = useRemoteAccessStore.getState();
  const { pendingAction, authMode, authPromptLabel } = state;
  const secret = state.authSecret.trim();
  if (authMode !== "host-trust" && secret.length === 0) {
    state.setAuthError(
      authMode === "password" ? "Enter the SSH password." : "Enter the SSH key passphrase.",
    );
    return;
  }
  if (!pendingAction || !authMode) {
    state.setAuthError("Remote access context was lost. Try opening the remote project again.");
    return;
  }
  state.setIsAuthenticating(true);
  state.setAuthError(null);
  try {
    const executionTargetId = pendingAction.executionTargetId;
    await submitSshAuthentication({
      executionTargetId,
      mode: authMode,
      promptLabel: authPromptLabel,
      secret,
    });
    if (!pendingAction.skipAgentVerification) {
      state.setExecutionTargetCheck(executionTargetId, resolveRemoteExecutionCheckingStatus());
      await verifyRemoteExecutionTarget({
        executionTargetId,
        ...(pendingAction.cwd ? { cwd: pendingAction.cwd } : {}),
      });
      state.markExecutionTargetVerified(executionTargetId);
    }
    state.clearAuthDialog();
    await pendingAction.onVerified();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to authenticate the SSH connection.";
    const failure = resolveRemoteExecutionFailureStatus(message);
    state.setExecutionTargetCheck(pendingAction.executionTargetId, failure);
    if (failure.status === "auth_required" && failure.authMode && failure.promptLabel) {
      if (failure.authMode !== authMode || failure.promptLabel !== authPromptLabel) {
        state.setAuthPrompt(failure.authMode, failure.promptLabel);
      } else state.setAuthError(message);
      return;
    }
    state.closeAuthDialog();
    showRemoteExecutionFailureToast({
      executionTargetId: pendingAction.executionTargetId,
      ...(pendingAction.unavailableTitle
        ? { unavailableTitle: pendingAction.unavailableTitle }
        : {}),
      check: failure,
      retry,
    });
  } finally {
    state.setIsAuthenticating(false);
  }
}
