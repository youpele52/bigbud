import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import {
  makeRemoteProcessClientResolver,
  makeRemoteWorkspaceClientResolver,
} from "./remoteAgentConnectionPool.resolvers.ts";
import { makeRemoteAgentGitCoreExecutor } from "./remoteAgentGit.ts";
import { makeRemoteAgentShellRunnerResolver } from "./remoteAgentShell.ts";
import { makeRemoteWorkspaceRuntime } from "../workspace-runtime/Layers/WorkspaceRuntime.remote.ts";
import { type RemoteAgentPtyResolver } from "./remoteAgentPtyAdapter.ts";
import { makeRemoteAgentToolRunner } from "./remoteAgentToolRunner.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { makeOwnedRemoteAgentPty } from "./remoteAgentOwnedPty.ts";
import { remoteAgentOwners } from "./remoteAgentOwners.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { observeLegacyRemoteAgentBinding } from "./remoteAgentLegacyBinding.ts";
import {
  cancelOwnedRemoteProcess,
  makeOwnedRemoteAgentProcess,
} from "./remoteAgentOwnedProcess.ts";

export interface RemoteAgentComposition {
  readonly managed: boolean;
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
  const managed = input.binaryPath === "$HOME/.bigbud/agent/bin/current";
  const pool = new RemoteAgentConnectionPool({
    ...(managed ? { resolveBinding: remoteAgentAdmission.resolveBinding } : {}),
    ...(managed
      ? {
          isRetiring: async (executionTargetId, binding) => {
            const state = await (await openRemoteAgentControl(executionTargetId)).registry.read();
            const buildId = remoteAgentBuildId(binding.runtime);
            return state.retirementReservations.some(
              (reservation) => reservation.buildId === buildId && reservation.phase !== "failed",
            );
          },
        }
      : {}),
    create: async (executionTargetId, binding) =>
      RemoteAgentConnection.ssh({
        executionTargetId,
        binaryPath: input.binaryPath,
        ...(binding ? { runtime: binding.runtime } : {}),
        ...(input.maxFrameBytes !== undefined ? { maxFrameBytes: input.maxFrameBytes } : {}),
      }),
  });
  const workspaceResolver = makeRemoteWorkspaceClientResolver(pool);
  const processResolver = makeRemoteProcessClientResolver(pool);
  const ownedRunner = managed ? { runOwned: makeOwnedRemoteAgentProcess(pool) } : {};
  // Custom binaries are observed, never promoted into the managed target admission.
  // The ordinary inventory/legacy connection may prepare its existing supervisor;
  // this profile lane and every recovery connection are strictly proxy-only.
  const resolveProfileBinding = managed
    ? remoteAgentAdmission.resolveBinding
    : async (target: string) =>
        observeLegacyRemoteAgentBinding(
          target,
          await openRemoteAgentControl(target),
          undefined,
          undefined,
          input.binaryPath,
        );
  const ownedPty = makeOwnedRemoteAgentPty(pool, remoteAgentOwners, resolveProfileBinding);
  const ptyResolver = {
    resolveProfileBinding,
    restoreOrCreate: managed
      ? ownedPty
      : async (spawn) => {
          const owner = await remoteAgentOwners().get(`terminal:${spawn.ownerKey}`);
          if (spawn.shellLaunch || spawn.recoverOnly || owner) return ownedPty(spawn);
          return undefined; // Preserve implicit ordinary account-login-shell creation.
        },
    resolvePty: (executionTargetId: string) => pool.getPtyClient(executionTargetId),
    resolveWorkspace: (_executionTargetId: string, connection: RemoteAgentConnection) =>
      Promise.resolve(new RemoteAgentWorkspaceClient(connection)),
  } satisfies RemoteAgentPtyResolver;
  return {
    managed,
    pool,
    workspaceRuntime: makeRemoteWorkspaceRuntime(workspaceResolver),
    gitExecutor: makeRemoteAgentGitCoreExecutor({ ...processResolver, ...ownedRunner }),
    shellRunner: makeRemoteAgentShellRunnerResolver({
      ...processResolver,
      ...ownedRunner,
      ...(managed
        ? {
            cancelOwned: (key: string) => cancelOwnedRemoteProcess(pool, key),
            isOwnedActive: async (key: string) => {
              const owner = await remoteAgentOwners().get(key);
              return Boolean(owner && owner.state !== "terminal");
            },
          }
        : {}),
    }),
    toolRunner: makeRemoteAgentToolRunner({
      ...processResolver,
      ...ownedRunner,
    }),
    ptyResolver,
  };
}
