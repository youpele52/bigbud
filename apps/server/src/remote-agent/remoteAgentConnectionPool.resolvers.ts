import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";

export function makeRemoteWorkspaceClientResolver(pool: RemoteAgentConnectionPool) {
  return {
    resolve: (executionTargetId: string) => pool.getWorkspaceClient(executionTargetId),
    resolveWatch: (executionTargetId: string) => pool.getWorkspaceWatchClient(executionTargetId),
  };
}

export function makeRemoteProcessClientResolver(pool: RemoteAgentConnectionPool) {
  return {
    resolve: (executionTargetId: string) => pool.getProcessClient(executionTargetId),
  };
}
