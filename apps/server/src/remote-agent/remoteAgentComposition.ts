import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import {
  makeInstalledProxyPoolFactory,
  type InstalledProxySelection,
} from "./remoteAgentComposition.installedProxy.ts";
import {
  RemoteAgentConnectionPool,
  type RemoteAgentConnectionPoolFactory,
} from "./remoteAgentConnectionPool.ts";
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
import { remoteAgentTerminalLifecycleOptions } from "./remoteAgentTerminalLifecycle.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { observeLegacyRemoteAgentBinding } from "./remoteAgentLegacyBinding.ts";
import {
  cancelOwnedRemoteProcess,
  makeOwnedRemoteAgentProcess,
} from "./remoteAgentOwnedProcess.ts";
import { installedRemoteAgentStartupRefusal } from "./remoteAgentInstalledStartup.state.ts";
import { remoteAgentOwnerSelection } from "./remoteAgentControl.selection.ts";
import { makeProductionRemoteAgentProxyOwner } from "./remoteAgentConnection.owner.production.ts";

export interface RemoteAgentComposition {
  readonly managed: boolean;
  readonly pool: RemoteAgentConnectionPool;
  readonly workspaceRuntime: ReturnType<typeof makeRemoteWorkspaceRuntime>;
  readonly gitExecutor: ReturnType<typeof makeRemoteAgentGitCoreExecutor>;
  readonly shellRunner: ReturnType<typeof makeRemoteAgentShellRunnerResolver>;
  readonly toolRunner: ReturnType<typeof makeRemoteAgentToolRunner>;
  readonly ptyResolver: RemoteAgentPtyResolver;
}

export function makeRemoteAgentComposition(
  input: { readonly maxFrameBytes?: number } & (
    | { readonly binaryPath: string; readonly installedProxy?: never }
    | { readonly installedProxy: InstalledProxySelection; readonly binaryPath?: never }
  ),
): RemoteAgentComposition {
  const managed =
    input.installedProxy !== undefined || input.binaryPath === "$HOME/.bigbud/agent/bin/current";
  const { binaryPath, maxFrameBytes } = input;
  const production = remoteAgentOwnerSelection();
  const raw: RemoteAgentConnectionPoolFactory =
    binaryPath === undefined
      ? makeInstalledProxyPoolFactory(input.installedProxy, maxFrameBytes)
      : {
          ...(managed
            ? {
                resolveBinding: remoteAgentAdmission.resolveBinding,
                isRetiring: async (executionTargetId, binding) => {
                  const state = await (
                    await openRemoteAgentControl(executionTargetId)
                  ).registry.read();
                  const buildId = remoteAgentBuildId(binding.runtime);
                  return state.retirementReservations.some(
                    (reservation) =>
                      reservation.buildId === buildId && reservation.phase !== "failed",
                  );
                },
              }
            : {}),
          create: async (executionTargetId, binding) => {
            // U25: under production activation every proxy is an owner lease for the exact
            // registry runtime; there is no SSH launch from this process and no fallback.
            if (production) {
              if (!binding)
                throw new RemoteAgentConnectionError(
                  "The SSH owner opens only a registry-bound agent proxy.",
                );
              return RemoteAgentConnection.ssh({
                executionTargetId,
                runtime: binding.runtime,
                owner: makeProductionRemoteAgentProxyOwner(production),
                ...(maxFrameBytes !== undefined ? { maxFrameBytes } : {}),
              });
            }
            return RemoteAgentConnection.ssh({
              executionTargetId,
              binaryPath,
              ...(binding ? { runtime: binding.runtime } : {}),
              ...(maxFrameBytes !== undefined ? { maxFrameBytes } : {}),
            });
          },
        };
  // A refused endpoint never re-enters through the process-default composition:
  // the refusal is typed and this pool refuses before any SSH launch.
  const factory = guardRefusedTargets(raw);
  const pool = new RemoteAgentConnectionPool(factory);
  const workspaceResolver = makeRemoteWorkspaceClientResolver(pool);
  const processResolver = makeRemoteProcessClientResolver(pool);
  const ownedRunner = managed ? { runOwned: makeOwnedRemoteAgentProcess(pool) } : {};
  // Custom binaries are observed, never promoted into the managed target admission.
  // The ordinary inventory/legacy connection may prepare its existing supervisor;
  // this profile lane and every recovery connection are strictly proxy-only.
  const resolveProfileBinding =
    factory.resolveBinding ??
    (async (target: string) =>
      observeLegacyRemoteAgentBinding(
        target,
        await openRemoteAgentControl(target),
        production
          ? (runtime) =>
              RemoteAgentConnection.ssh({
                executionTargetId: target,
                runtime,
                owner: makeProductionRemoteAgentProxyOwner(production),
              })
          : undefined,
        undefined,
        binaryPath,
      ));
  // With the terminal host enabled, remote terminals are lifecycle-managed too (plan §7.2).
  const ownedPty = makeOwnedRemoteAgentPty(
    pool,
    remoteAgentOwners,
    resolveProfileBinding,
    remoteAgentTerminalLifecycleOptions(),
  );
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

function guardRefusedTargets(
  factory: RemoteAgentConnectionPoolFactory,
): RemoteAgentConnectionPoolFactory {
  const refuse = (target: string) => {
    const reason = installedRemoteAgentStartupRefusal(target);
    if (reason) {
      throw new RemoteAgentConnectionError(
        `Installed agent startup refused this endpoint (${reason}).`,
      );
    }
  };
  return {
    create: async (executionTargetId, binding) => {
      refuse(executionTargetId);
      return factory.create(executionTargetId, binding);
    },
    ...(factory.resolveBinding
      ? {
          resolveBinding: async (executionTargetId: string) => {
            refuse(executionTargetId);
            return factory.resolveBinding?.(executionTargetId);
          },
        }
      : {}),
    ...(factory.isRetiring ? { isRetiring: factory.isRetiring } : {}),
    ...(factory.retirementFence ? { retirementFence: factory.retirementFence } : {}),
  };
}
