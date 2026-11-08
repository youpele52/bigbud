import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";

function runtimeIdentity(binding: RemoteAgentRuntimeBinding): ReadonlyArray<string> {
  return [
    binding.runtime.generation,
    binding.expectedEpoch,
    binding.runtime.buildDigest,
    binding.runtime.socketPath,
  ];
}

/** Pool entry identity: one entry per target and runtime epoch, or one external entry. */
export function remoteAgentPoolEntryKey(
  executionTargetId: string,
  binding?: RemoteAgentRuntimeBinding,
): string {
  return JSON.stringify([executionTargetId, binding ? runtimeIdentity(binding) : "external"]);
}

export function remoteAgentPoolRuntimeKey(binding: RemoteAgentRuntimeBinding): string {
  return JSON.stringify(runtimeIdentity(binding));
}

export function remoteAgentPoolBindingKey(
  executionTargetId: string,
  binding: RemoteAgentRuntimeBinding,
): string {
  return JSON.stringify([executionTargetId, remoteAgentPoolRuntimeKey(binding)]);
}
