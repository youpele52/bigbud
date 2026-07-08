import { toastManager } from "../components/ui/toast";
import type { RemoteExecutionCheckState } from "../stores/remoteAccess/remoteAccess.store";
import { useRemoteAccessStore } from "../stores/remoteAccess/remoteAccess.store";
import {
  REMOTE_EXECUTION_BACKGROUND_TOAST_INTERVAL_MS,
  resolveRemoteExecutionCheckingStatus,
  resolveRemoteExecutionFailureStatus,
  resolveRemoteExecutionVerifiedStatus,
} from "./useRemoteExecutionAccessGate.shared";

export function formatRemoteExecutionToastDescription(
  check: Pick<RemoteExecutionCheckState, "message" | "tip">,
) {
  return check.tip ? `${check.message} ${check.tip}` : check.message;
}

type ActiveRemoteExecutionCheck = {
  readonly promise: Promise<void>;
  readonly unavailableTitle?: string;
  backgroundToastId: ReturnType<typeof toastManager.add> | null;
  backgroundToastIntervalId: number | null;
};

const activeRemoteExecutionChecks = new Map<string, ActiveRemoteExecutionCheck>();

export function readRemoteExecutionCheck(
  executionTargetId: string,
): RemoteExecutionCheckState | undefined {
  return useRemoteAccessStore.getState().executionTargetChecks[executionTargetId];
}

function clearBackgroundRemoteExecutionToast(executionTargetId: string) {
  const active = activeRemoteExecutionChecks.get(executionTargetId);
  if (!active) {
    return;
  }
  if (active.backgroundToastIntervalId !== null) {
    window.clearInterval(active.backgroundToastIntervalId);
    active.backgroundToastIntervalId = null;
  }
  if (active.backgroundToastId !== null) {
    toastManager.close(active.backgroundToastId);
    active.backgroundToastId = null;
  }
}

export function ensureBackgroundRemoteExecutionToast(input: {
  readonly executionTargetId: string;
  readonly unavailableTitle?: string;
}) {
  const active = activeRemoteExecutionChecks.get(input.executionTargetId);
  const check = readRemoteExecutionCheck(input.executionTargetId);
  if (!active || !check || active.backgroundToastIntervalId !== null) {
    return;
  }

  const title = input.unavailableTitle ?? "Checking remote project";
  active.backgroundToastId = toastManager.add({
    type: "loading",
    title,
    description: formatRemoteExecutionToastDescription(check),
    timeout: 0,
    data: {
      hideCopyButton: true,
    },
  });
  active.backgroundToastIntervalId = window.setInterval(() => {
    const nextCheck = readRemoteExecutionCheck(input.executionTargetId);
    if (!nextCheck || nextCheck.status !== "checking" || active.backgroundToastId === null) {
      return;
    }
    toastManager.update(active.backgroundToastId, {
      type: "loading",
      title,
      description: formatRemoteExecutionToastDescription(nextCheck),
      timeout: 0,
      data: {
        hideCopyButton: true,
      },
    });
  }, REMOTE_EXECUTION_BACKGROUND_TOAST_INTERVAL_MS);
}

function notifyRemoteExecutionCheckCompleted(executionTargetId: string) {
  const active = activeRemoteExecutionChecks.get(executionTargetId);
  const check = readRemoteExecutionCheck(executionTargetId);
  if (!active || !check) {
    return;
  }
  const shouldNotify =
    active.backgroundToastId !== null || active.backgroundToastIntervalId !== null;
  clearBackgroundRemoteExecutionToast(executionTargetId);
  if (!shouldNotify) {
    return;
  }

  if (check.status === "verified") {
    toastManager.add({
      type: "success",
      title: "Remote project ready",
      description: check.message,
    });
    return;
  }
  if (check.status === "auth_required") {
    toastManager.add({
      type: "info",
      title: "Remote authentication required",
      description: formatRemoteExecutionToastDescription(check),
    });
    return;
  }
  if (check.status === "error") {
    toastManager.add({
      type: "error",
      title: active.unavailableTitle ?? "Remote project unavailable",
      description: formatRemoteExecutionToastDescription(check),
    });
  }
}

export function startRemoteExecutionCheck(input: {
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly unavailableTitle?: string;
  readonly verify: (input: {
    readonly executionTargetId: string;
    readonly cwd?: string;
  }) => Promise<void>;
}) {
  const existing = activeRemoteExecutionChecks.get(input.executionTargetId);
  if (existing) {
    return existing;
  }

  useRemoteAccessStore
    .getState()
    .setExecutionTargetCheck(input.executionTargetId, resolveRemoteExecutionCheckingStatus());

  const active: ActiveRemoteExecutionCheck = {
    backgroundToastId: null,
    backgroundToastIntervalId: null,
    promise: (async () => {
      try {
        await input.verify({
          executionTargetId: input.executionTargetId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        });
        useRemoteAccessStore
          .getState()
          .setExecutionTargetCheck(input.executionTargetId, resolveRemoteExecutionVerifiedStatus());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to reconnect to the remote project.";
        useRemoteAccessStore
          .getState()
          .setExecutionTargetCheck(
            input.executionTargetId,
            resolveRemoteExecutionFailureStatus(errorMessage),
          );
      } finally {
        notifyRemoteExecutionCheckCompleted(input.executionTargetId);
        activeRemoteExecutionChecks.delete(input.executionTargetId);
      }
    })(),
    ...(input.unavailableTitle ? { unavailableTitle: input.unavailableTitle } : {}),
  };
  activeRemoteExecutionChecks.set(input.executionTargetId, active);
  return active;
}
