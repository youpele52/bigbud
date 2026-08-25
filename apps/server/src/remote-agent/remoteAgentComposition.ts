import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import {
  RemoteAgentConnectionPool,
  makeRemoteProcessClientResolver,
  makeRemoteWorkspaceClientResolver,
} from "./remoteAgentConnectionPool.ts";
import { makeRemoteAgentGitCoreExecutor } from "./remoteAgentGit.ts";
import { makeRemoteAgentShellRunnerResolver } from "./remoteAgentShell.ts";
import { makeRemoteWorkspaceRuntime } from "../workspace-runtime/Layers/WorkspaceRuntime.remote.ts";
import { type RemoteAgentPtyResolver } from "./remoteAgentPtyAdapter.ts";
import { makeRemoteAgentToolRunner } from "./remoteAgentToolRunner.ts";

export interface RemoteAgentComposition {
  readonly pool: RemoteAgentConnectionPool;
  readonly workspaceRuntime: ReturnType<typeof makeRemoteWorkspaceRuntime>;
  readonly gitExecutor: ReturnType<typeof makeRemoteAgentGitCoreExecutor>;
  readonly shellRunner: ReturnType<typeof makeRemoteAgentShellRunnerResolver>;
  readonly toolRunner: ReturnType<typeof makeRemoteAgentToolRunner>;
  readonly ptyResolver: RemoteAgentPtyResolver;
}

export function makeRemoteAgentComposition(input: {
  readonly binaryPath: string;
  readonly maxFrameBytes?: number;
}): RemoteAgentComposition {
  const pool = new RemoteAgentConnectionPool({
    create: async (executionTargetId) =>
      RemoteAgentConnection.ssh({
        executionTargetId,
        binaryPath: input.binaryPath,
        ...(input.maxFrameBytes !== undefined ? { maxFrameBytes: input.maxFrameBytes } : {}),
      }),
  });
  const workspaceResolver = makeRemoteWorkspaceClientResolver(pool);
  const processResolver = makeRemoteProcessClientResolver(pool);
  const ptyResolver = {
    resolvePty: (executionTargetId: string) => pool.getPtyClient(executionTargetId),
    resolveWorkspace: (executionTargetId: string) => pool.getWorkspaceClient(executionTargetId),
  } satisfies RemoteAgentPtyResolver;
  return {
    pool,
    workspaceRuntime: makeRemoteWorkspaceRuntime(workspaceResolver),
    gitExecutor: makeRemoteAgentGitCoreExecutor(processResolver),
    shellRunner: makeRemoteAgentShellRunnerResolver(processResolver),
    toolRunner: makeRemoteAgentToolRunner(processResolver),
    ptyResolver,
  };
}
