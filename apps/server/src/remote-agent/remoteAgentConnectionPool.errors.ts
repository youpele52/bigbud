import { RemoteAgentConnectionError } from "./remoteAgentConnection.ts";

export class RemoteAgentCapabilityError extends Error {
  readonly _tag = "RemoteAgentCapabilityError";

  constructor(
    readonly executionTargetId: string,
    readonly capability: string,
  ) {
    super(`Remote agent '${executionTargetId}' does not advertise capability '${capability}'.`);
    this.name = "RemoteAgentCapabilityError";
  }
}

export const REMOTE_SERVICE_RESTARTED = "remote-service-restarted";

export function isRemoteAgentRestartError(cause: unknown): boolean {
  return cause instanceof RemoteAgentConnectionError && cause.message === REMOTE_SERVICE_RESTARTED;
}
