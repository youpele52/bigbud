/**
 * Drops a stale "verified" flag when the thread's newest turn-start failure says its remote
 * target was unavailable. The renderer otherwise keeps `verified` after an SSH connection drops
 * (password sessions expire on their own), so navigation and send would skip the access check.
 * Only failures newer than the target's last check apply; nothing polls in the background.
 */
import type { TurnStartRemoteTargetFailure } from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";
import { useEffect } from "react";

import { resolveRemoteExecutionFailureStatus } from "../../hooks/useRemoteExecutionAccessGate.shared";
import { extractRemoteTargetMessage } from "../../lib/remoteTargetFailure";
import { type RemoteExecutionCheckState, useRemoteAccessStore } from "./remoteAccess.store";

export interface RemoteTargetFailureSignal {
  readonly remoteTarget: TurnStartRemoteTargetFailure;
  /** Server time the failure was recorded. */
  readonly createdAt: string;
  readonly detail?: string | undefined;
}

/** A user Disconnect has its own sticky flag; only auth/unreachable failures invalidate. */
export function isRemoteTargetFailureNewerThanCheck(
  failure: RemoteTargetFailureSignal | null | undefined,
  check: Pick<RemoteExecutionCheckState, "status" | "updatedAt"> | undefined,
): failure is RemoteTargetFailureSignal {
  if (!failure || failure.remoteTarget.reason === "disconnected") return false;
  if (check?.status === "checking") return false;
  if (!check) return true;
  const failedAt = Date.parse(failure.createdAt);
  const checkedAt = Date.parse(check.updatedAt);
  return Number.isFinite(failedAt) && (!Number.isFinite(checkedAt) || failedAt > checkedAt);
}

/** The check state a remote-target failure implies (auth prompt details when parseable). */
export function remoteTargetFailureCheck(failure: RemoteTargetFailureSignal) {
  const message =
    extractRemoteTargetMessage(failure.detail) ??
    failure.detail ??
    "The remote workspace is not connected.";
  return resolveRemoteExecutionFailureStatus(message);
}

/** Applies the failure to the target's check when it is newer; returns whether it applied. */
export function invalidateRemoteTargetFromFailure(
  executionTargetId: string,
  failure: RemoteTargetFailureSignal | null | undefined,
): boolean {
  const state = useRemoteAccessStore.getState();
  if (!isRemoteTargetFailureNewerThanCheck(failure, state.executionTargetChecks[executionTargetId]))
    return false;
  state.setExecutionTargetCheck(executionTargetId, remoteTargetFailureCheck(failure));
  return true;
}

/** Per visible thread: invalidate once its newest failure is seen (keyed by primitives). */
export function useRemoteTargetFailureInvalidation(
  executionTargetId: string | null | undefined,
  failure: RemoteTargetFailureSignal | null | undefined,
) {
  const reason = failure?.remoteTarget.reason;
  const authMode = failure?.remoteTarget.authMode;
  const createdAt = failure?.createdAt;
  const detail = failure?.detail;
  useEffect(() => {
    if (!executionTargetId || !reason || !createdAt) return;
    invalidateRemoteTargetFromFailure(executionTargetId, {
      remoteTarget: { reason, ...(authMode ? { authMode } : {}) },
      createdAt,
      detail,
    });
  }, [executionTargetId, reason, authMode, createdAt, detail]);
}
