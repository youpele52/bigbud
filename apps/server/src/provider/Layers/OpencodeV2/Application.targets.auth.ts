import { registerRemoteWorkspaceExecutions } from "../../../remote-workspace-bridge/remoteWorkspaceExecutions.ts";
import {
  prepareThreadOrchestrationSessionAuth,
  resolveThreadOrchestrationHttpConfig,
} from "../../../orchestration-tools/threadOrchestrationBridge.shared.ts";
import {
  deleteThreadOrchestrationToolAuth,
  renewThreadOrchestrationToolAuth,
  type ThreadToolWorkspaceBinding,
} from "../../../orchestration-tools/ThreadOrchestrationToolAuth.ts";

/** Canonical HTTP auth is app-internal; native enrollment receives a different per-owner callback token. */
export async function prepareV2SharedCanonicalResources(
  stateDir: string,
  threadId: string,
  port: number,
  workspaceBinding: ThreadToolWorkspaceBinding,
) {
  const { token } = await prepareThreadOrchestrationSessionAuth({
    stateDir,
    threadId,
    workspaceBinding,
  });
  let executions: ReturnType<typeof registerRemoteWorkspaceExecutions> | undefined;
  try {
    if (workspaceBinding.executionTargetId !== "local")
      executions = registerRemoteWorkspaceExecutions(token, JSON.stringify([stateDir, threadId]));
  } catch (cause) {
    await deleteThreadOrchestrationToolAuth({ stateDir, threadId, token });
    throw cause;
  }
  return {
    ...(executions ? { remoteCommands: executions.owner } : {}),
    orchestration: resolveThreadOrchestrationHttpConfig(
      { stateDir, threadId, host: "127.0.0.1", port, providerSessionId: `opencodeV2:${threadId}` },
      token,
    ),
    cleanup: async () => {
      await deleteThreadOrchestrationToolAuth({ stateDir, threadId, token });
      await executions?.close();
    },
    renewCanonicalAuth: () => renewThreadOrchestrationToolAuth({ stateDir, threadId, token }),
  };
}
