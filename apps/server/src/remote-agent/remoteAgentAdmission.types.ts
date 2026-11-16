import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";

export class RemoteAgentAdmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly buildFailure = false,
    options?: ErrorOptions,
    readonly committedRequestId?: string,
  ) {
    super(message, options);
  }
}

export function nextRemoteAgentRegistryRevision(
  state: RemoteAgentRegistry,
  patch: Partial<RemoteAgentRegistry>,
): RemoteAgentRegistry {
  return parseRemoteAgentRegistry(
    JSON.stringify({ ...state, ...patch, revision: state.revision + 1 }),
  );
}
