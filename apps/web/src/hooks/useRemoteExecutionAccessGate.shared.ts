import { type AppCheckStatus } from "../lib/checkStatus";
import { getPassphraseProtectedSshKeyPath, getPasswordProtectedSshTargetLabel } from "../lib/ssh";
import type { RemoteExecutionAuthMode } from "../stores/remoteAccess/remoteAccess.store";

export const REMOTE_EXECUTION_FOREGROUND_TIMEOUT_MS = 5_000;
export const REMOTE_EXECUTION_BACKGROUND_TOAST_INTERVAL_MS = 120_000;

export interface RemoteExecutionCheckStatus {
  readonly status: AppCheckStatus;
  readonly message: string;
  readonly tip: string | null;
  readonly authMode: RemoteExecutionAuthMode | null;
  readonly promptLabel: string | null;
}

export function resolveRemoteExecutionCheckingStatus(): RemoteExecutionCheckStatus {
  return {
    status: "checking",
    message: "Checking remote access. bigbud will keep checking in the background.",
    tip: "You can keep working while the remote connection check finishes.",
    authMode: null,
    promptLabel: null,
  };
}

export function resolveRemoteExecutionVerifiedStatus(): RemoteExecutionCheckStatus {
  return {
    status: "verified",
    message: "Remote access verified.",
    tip: null,
    authMode: null,
    promptLabel: null,
  };
}

function resolveRemoteExecutionErrorTip(errorMessage: string): string {
  if (/timed out/i.test(errorMessage)) {
    return "Check that the host is reachable, SSH is responsive, and the remote path exists.";
  }
  if (/not found/i.test(errorMessage) || /enoent/i.test(errorMessage)) {
    return "Check that the required SSH or system binary is installed and available on this machine.";
  }
  if (/offline/i.test(errorMessage) || /unreachable/i.test(errorMessage)) {
    return "Reconnect the machine to the network or VPN, then try again.";
  }
  return "Check the remote host, SSH credentials, and network reachability, then try again.";
}

export function resolveRemoteExecutionFailureStatus(
  errorMessage: string,
): RemoteExecutionCheckStatus {
  const keyPath = getPassphraseProtectedSshKeyPath(errorMessage);
  if (keyPath) {
    return {
      status: "auth_required",
      message: errorMessage,
      tip: "Enter the SSH key passphrase to finish verifying remote access.",
      authMode: "ssh-key-passphrase",
      promptLabel: keyPath,
    };
  }

  const targetLabel = getPasswordProtectedSshTargetLabel(errorMessage);
  if (targetLabel) {
    return {
      status: "auth_required",
      message: errorMessage,
      tip: "Enter the SSH password to finish verifying remote access.",
      authMode: "password",
      promptLabel: targetLabel,
    };
  }

  return {
    status: "error",
    message: errorMessage,
    tip: resolveRemoteExecutionErrorTip(errorMessage),
    authMode: null,
    promptLabel: null,
  };
}
