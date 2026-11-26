import { isRemoteExecutionTargetId } from "../components/sidebar/Sidebar.remoteWorkspaces.logic";
import { toastManager } from "../components/ui/toast";
import {
  areDisconnectedTargetsLoaded,
  isExecutionTargetDisconnected,
  isExecutionTargetVerified,
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
import { blockDisconnectedRemoteExecutionTarget } from "./useRemoteExecutionAccessGate.connection";

export interface EnsureRemoteExecutionTargetAccessInput {
  readonly executionTargetId: string | null | undefined;
  readonly cwd?: string;
  readonly unavailableTitle?: string;
  readonly onVerified?: () => Promise<void> | void;
  readonly resumeOnUnlockOnly?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** True while the one global auth dialog is already waiting on this same target. */
export function isRemoteExecutionAuthPendingFor(executionTargetId: string): boolean {
  return useRemoteAccessStore.getState().pendingAction?.executionTargetId === executionTargetId;
}

export function openRemoteExecutionAuthDialog(input: {
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly onVerified?: () => Promise<void> | void;
  readonly onCancel?: () => void;
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
      ...(input.onCancel ? { onCancel: input.onCancel } : {}),
      ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
    },
    authMode: input.authMode,
    promptLabel: input.promptLabel,
  });
}

/** Opens the auth dialog; a dialog already pending for the same target is joined silently. */
function promptRemoteExecutionAuth(
  input: EnsureRemoteExecutionTargetAccessInput & { readonly executionTargetId: string },
  authMode: RemoteExecutionAuthMode,
  promptLabel: string,
) {
  const opened = openRemoteExecutionAuthDialog({
    executionTargetId: input.executionTargetId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.onVerified ? { onVerified: input.onVerified } : {}),
    ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
    authMode,
    promptLabel,
  });
  if (!opened && !isRemoteExecutionAuthPendingFor(input.executionTargetId)) {
    toastManager.add({
      type: "warning",
      title: "Another remote authentication request is already pending.",
    });
  }
}

async function proceed(input: EnsureRemoteExecutionTargetAccessInput): Promise<true> {
  if (!input.resumeOnUnlockOnly) {
    await input.onVerified?.();
  }
  return true;
}

export async function beginRemoteExecutionTargetAccessCheck(
  input: EnsureRemoteExecutionTargetAccessInput,
): Promise<boolean> {
  if (!input.executionTargetId || !isRemoteExecutionTargetId(input.executionTargetId)) {
    return proceed(input);
  }
  const executionTargetId = input.executionTargetId;

  // Navigation only reads local history, so a user-disconnected target proceeds unverified,
  // as does any target before the server's disconnect list has loaded.
  if (
    // Read live: Connect clears verification just before re-checking.
    isExecutionTargetVerified(executionTargetId) ||
    isExecutionTargetDisconnected(executionTargetId) ||
    !areDisconnectedTargetsLoaded()
  ) {
    return proceed(input);
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
  const check = readRemoteExecutionCheck(executionTargetId);

  if (outcome === "timeout") {
    ensureBackgroundRemoteExecutionToast({
      executionTargetId,
      ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
    });
    return proceed(input);
  }

  if (check?.status === "verified") {
    return proceed(input);
  }

  if (check?.status === "auth_required" && check.authMode !== null && check.promptLabel !== null) {
    promptRemoteExecutionAuth({ ...input, executionTargetId }, check.authMode, check.promptLabel);
    return false;
  }

  showRemoteExecutionFailureToast({
    executionTargetId,
    ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
    check:
      check ?? resolveRemoteExecutionFailureStatus("Failed to reconnect to the remote workspace."),
    retry: () => {
      void beginRemoteExecutionTargetAccessCheck({ ...input, resumeOnUnlockOnly: false });
    },
  });
  return false;
}

export async function ensureRemoteExecutionTargetAccess(
  input: EnsureRemoteExecutionTargetAccessInput,
): Promise<boolean> {
  if (!input.executionTargetId || !isRemoteExecutionTargetId(input.executionTargetId)) {
    return proceed(input);
  }
  const executionTargetId = input.executionTargetId;
  if (
    blockDisconnectedRemoteExecutionTarget({
      executionTargetId,
      onConnected: () =>
        beginRemoteExecutionTargetAccessCheck({ ...input, resumeOnUnlockOnly: false }),
    })
  ) {
    return false;
  }

  // Auth dialogs retain callbacks across renders; verification must be read live.
  if (isExecutionTargetVerified(executionTargetId)) {
    return proceed(input);
  }

  const check = readRemoteExecutionCheck(executionTargetId);
  if (check?.status === "auth_required" && check.authMode !== null && check.promptLabel !== null) {
    promptRemoteExecutionAuth({ ...input, executionTargetId }, check.authMode, check.promptLabel);
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

  // The background check waits for the disconnect list; the server still guards the action.
  if (check?.status !== "checking" && areDisconnectedTargetsLoaded()) {
    startRemoteExecutionCheck({
      executionTargetId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
      verify: verifyRemoteExecutionTarget,
    });
  }
  return proceed(input);
}
