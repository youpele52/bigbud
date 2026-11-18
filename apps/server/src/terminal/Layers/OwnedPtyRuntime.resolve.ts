import type { PtyAdapterShape } from "../Services/PTY.ts";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import {
  getConfiguredRemoteAgentComposition,
  isRemoteAgentExecutionTarget,
} from "../../remote-agent/remoteAgentDefault.ts";
import { remoteAgentOwners } from "../../remote-agent/remoteAgentOwners.ts";
import { openRemoteAgentControl } from "../../remote-agent/remoteAgentControl.ts";

/** Keep the historical SSH composition as fallback; local Rust transports opt in explicitly. */
export function resolveOwnedPtyRuntime(
  adapter: Pick<PtyAdapterShape, "ownedRuntimeForTarget"> | undefined,
  executionTargetId: string,
): OwnedPtyRuntime | undefined {
  const scoped = adapter?.ownedRuntimeForTarget?.(executionTargetId);
  if (scoped) return scoped;
  return resolveDefaultOwnedPtyRuntime(executionTargetId);
}

export function resolveDefaultOwnedPtyRuntime(
  executionTargetId: string,
): OwnedPtyRuntime | undefined {
  if (!isRemoteAgentExecutionTarget(executionTargetId)) return undefined;
  const composition = getConfiguredRemoteAgentComposition();
  if (!composition?.ptyResolver.restoreOrCreate) return undefined;
  return {
    targetId: executionTargetId,
    pool: composition.pool,
    owners: remoteAgentOwners,
    control: () => openRemoteAgentControl(executionTargetId),
    pidNamespace: "ssh-host",
  };
}

export function sessionOwnedPtyRuntime(
  context: {
    readonly resolveOwnedRuntime?: ((target: string) => OwnedPtyRuntime | undefined) | undefined;
  },
  target: string,
) {
  return context.resolveOwnedRuntime
    ? context.resolveOwnedRuntime(target)
    : resolveDefaultOwnedPtyRuntime(target);
}
