import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

export class RemoteAgentAdmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly buildFailure = false,
  ) {
    super(message);
  }
}

export function nextRemoteAgentRegistryRevision(
  state: RemoteAgentRegistry,
  patch: Partial<RemoteAgentRegistry>,
): RemoteAgentRegistry {
  return { ...state, ...patch, revision: state.revision + 1 };
}
