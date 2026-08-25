import { RemoteAgentConnectionError } from "../../remote-agent/remoteAgentConnection.ts";
import type { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";

export interface RemoteWorkspaceReadResolver {
  readonly resolve: (executionTargetId: string) => Promise<RemoteAgentWorkspaceClient>;
}

export async function withRemoteReadReconnect<T>(input: {
  readonly resolver: RemoteWorkspaceReadResolver;
  readonly target: string;
  readonly operation: (client: RemoteAgentWorkspaceClient) => Promise<T>;
}): Promise<T> {
  let client = await input.resolver.resolve(input.target);
  try {
    return await input.operation(client);
  } catch (cause) {
    if (!(cause instanceof RemoteAgentConnectionError)) throw cause;
    client = await input.resolver.resolve(input.target);
    return input.operation(client);
  }
}
