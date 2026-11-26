/**
 * Non-destructive "re-establish access" for a remote target, used by the thread gate and the
 * thread remote-target notice (never restarts the remote service; that is the menus' Reconnect).
 *
 * Runs one bounded silent check, shared with every other caller for the same target
 * (`startRemoteExecutionCheck` joins an in-flight check), and prompts only when the check
 * reports that a password, key passphrase or host-trust decision is needed.
 */
import { toastManager } from "../../components/ui/toast";
import {
  isRemoteExecutionAuthPendingFor,
  openRemoteExecutionAuthDialog,
} from "../../hooks/useRemoteExecutionAccessGate.access";
import {
  readRemoteExecutionCheck,
  startRemoteExecutionCheck,
} from "../../hooks/useRemoteExecutionAccessGate.checks";
import { verifyRemoteExecutionTarget } from "../../hooks/useRemoteExecutionAccessGate.verification";

export type RemoteTargetAccessOutcome = "verified" | "auth_required" | "error";

interface RemoteTargetAccessInput {
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly onVerified?: () => Promise<void> | void;
}

/**
 * Opens the global auth dialog for the target's current auth need. A dialog already pending for
 * the same target is joined (no second dialog, no toast); another target's keeps its warning.
 */
export function promptRemoteTargetAuth(input: RemoteTargetAccessInput): boolean {
  if (isRemoteExecutionAuthPendingFor(input.executionTargetId)) return true;
  const check = readRemoteExecutionCheck(input.executionTargetId);
  if (check?.status !== "auth_required" || !check.authMode || !check.promptLabel) return false;
  const opened = openRemoteExecutionAuthDialog({
    executionTargetId: input.executionTargetId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    onVerified: input.onVerified ?? (() => undefined),
    authMode: check.authMode,
    promptLabel: check.promptLabel,
  });
  if (!opened) {
    toastManager.add({
      type: "warning",
      title: "Another remote authentication request is already pending.",
    });
  }
  return opened;
}

/** One silent, shared check; prompts for credentials only when `prompt` and the check asks. */
export async function reconnectRemoteTargetAccess(
  input: RemoteTargetAccessInput & { readonly prompt: boolean },
): Promise<RemoteTargetAccessOutcome> {
  const active = startRemoteExecutionCheck({
    executionTargetId: input.executionTargetId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    verify: verifyRemoteExecutionTarget,
  });
  await active.promise;
  const check = readRemoteExecutionCheck(input.executionTargetId);
  if (check?.status === "verified") {
    await input.onVerified?.();
    return "verified";
  }
  if (check?.status === "auth_required") {
    if (input.prompt) promptRemoteTargetAuth(input);
    return "auth_required";
  }
  return "error";
}
