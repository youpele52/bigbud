import type {
  ServerRestartRemoteAgentInput,
  ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentRestartDependencies } from "./remoteAgentRestart.dependencies.ts";
import type { RemoteAgentRestartRecord } from "./remoteAgentRestart.types.ts";
import { resultFor } from "./remoteAgentRestart.store.ts";
import { restartRemoteAgentRuntime } from "./remoteAgentRestart.runtime.ts";
export { RemoteAgentRestartCompletionError, terminalPhases } from "./remoteAgentRestart.runtime.ts";

function runtimeProgress(record: RemoteAgentRestartRecord) {
  const { projectId: _projectId, ...progress } = record;
  return progress;
}

/** Project RPC presentation adapts the same canonical runtime transition used by account boot. */
export async function restartRemoteAgent(
  dependencies: RemoteAgentRestartDependencies,
  request: ServerRestartRemoteAgentInput,
  initialBinding?: RemoteAgentRuntimeBinding,
): Promise<ServerRestartRemoteAgentResult> {
  const store = dependencies.store;
  const record = await restartRemoteAgentRuntime(
    {
      ...dependencies,
      store: {
        get: async (id) => {
          const current = await store.get(id);
          return current ? runtimeProgress(current) : undefined;
        },
        put: (progress) => store.put({ ...progress, projectId: request.projectId }),
        update: async (id, transition) =>
          runtimeProgress(
            await store.update(id, (current) => ({
              ...current,
              ...transition(runtimeProgress(current)),
            })),
          ),
      },
    },
    {
      requestId: request.requestId,
      expectedWorkspaceExecutionTargetId: request.expectedWorkspaceExecutionTargetId,
    },
    initialBinding,
  );
  return resultFor({ ...record, projectId: request.projectId }, request);
}
