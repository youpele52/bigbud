import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import type { RemoteAgentProxyOwner } from "./remoteAgentConnection.owner.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import { samePoolBinding } from "./remoteAgentConnectionPool.entry.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";

/** An already admitted installation and an owner scoped to that installation. */
export interface InstalledProxySelection {
  readonly executionTargetId: string;
  readonly binding: RemoteAgentRuntimeBinding & { readonly expectedInstanceId: string };
  readonly owner: RemoteAgentProxyOwner;
}

export function makeInstalledProxyPoolFactory(
  { executionTargetId, binding, owner }: InstalledProxySelection,
  maxFrameBytes?: number,
) {
  const selected = Object.freeze({
    ...binding,
    runtime: validateRemoteAgentRuntime(binding.runtime),
  });
  if (
    selected.runtime.origin !== "managed" ||
    !selected.expectedEpoch ||
    !selected.expectedInstanceId
  ) {
    throw new RemoteAgentConnectionError(
      "Installed agent proxy requires a pinned managed instance.",
    );
  }
  const deny = () =>
    new RemoteAgentConnectionError(
      "Installed agent proxy selection does not match.",
      "IDENTITY_MISMATCH",
    );
  return {
    async resolveBinding(target: string) {
      if (target !== executionTargetId) throw deny();
      return selected;
    },
    async create(target: string, requested?: RemoteAgentRuntimeBinding) {
      if (target !== executionTargetId || !samePoolBinding(selected, requested)) throw deny();
      return RemoteAgentConnection.ssh({
        executionTargetId,
        runtime: selected.runtime,
        owner,
        timeoutMs: 10_000,
        ...(maxFrameBytes !== undefined ? { maxFrameBytes } : {}),
      });
    },
  };
}
