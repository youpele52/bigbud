import {
  assertSshTargetConnected,
  RemoteTargetDisconnectedError,
} from "../ssh/sshTargetDisconnects.ts";

/**
 * In-process removal fence for the connection pool: while an agent removal runs for a target,
 * the pool refuses to dial it, so a background consumer cannot reopen a connection to the build
 * being deleted. The removal's own control commands use plain SSH, not the pool.
 */
const removingTargets = new Map<string, number>();

export function beginRemoteAgentTargetRemoval(executionTargetId: string): () => void {
  removingTargets.set(executionTargetId, (removingTargets.get(executionTargetId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (removingTargets.get(executionTargetId) ?? 1) - 1;
    if (remaining > 0) removingTargets.set(executionTargetId, remaining);
    else removingTargets.delete(executionTargetId);
  };
}

export function isRemoteAgentTargetRemoving(executionTargetId: string): boolean {
  return removingTargets.has(executionTargetId);
}

/** The pool's dial guard: a user disconnect or a removal in progress both refuse to connect. */
export function assertRemoteAgentTargetUsable(executionTargetId: string): void {
  assertSshTargetConnected(executionTargetId);
  if (removingTargets.has(executionTargetId))
    throw new RemoteTargetDisconnectedError(executionTargetId);
}
