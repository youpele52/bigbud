import { Layer, ServiceMap } from "effect";

import { makeSshGitExecutor } from "../git/Layers/GitCore.ssh.ts";
import { RemoteAgentGitExecutorService, RemoteAgentGitOwnership } from "./remoteAgentGit.ts";
import type { RemoteAgentPtyResolver } from "./remoteAgentPtyAdapter.ts";
import { RemoteAgentShellRunner } from "./remoteAgentShell.ts";
import {
  buildRemoteAgentIdentityProbeCommand,
  RemoteAgentConnectionError,
} from "./remoteAgentConnection.ts";
import {
  makeRemoteAgentInstallManager,
  type RemoteAgentInstallSource,
} from "./remoteAgentInstallManager.ts";
import type { RemoteAgentArtifact } from "./remoteAgentArtifact.ts";
import { loadProcessScopedRemoteAgentInstallSource } from "./remoteAgentInstallSource.ts";
import { parseRemoteAgentCheckOutput, remoteAgentIdentityMatches } from "./remoteAgentIdentity.ts";
import {
  getConfiguredRemoteAgentComposition,
  resolveRemoteAgentConfiguration,
} from "./remoteAgentDefault.ts";
import { RemoteWorkspaceRuntime } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import {
  WorkspaceRuntimeLayerLive,
  makeWorkspaceRuntimeLayer,
} from "../workspace-runtime/Layers/WorkspaceRuntime.ts";
import { runSshCommand } from "../ssh/sshProcess.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import { RemoteAgentRuntimeBindingsLive } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import type { ServerRemoteAgentRuntimeSummary } from "@bigbud/contracts/server/server.ts";
import {
  makeRemoteAgentUpdateCoordinator,
  RemoteAgentUpdateCoordinator,
  type RemoteAgentUpdateCoordinatorShape,
} from "./remoteAgentUpdate.coordinator.ts";
import type { RemoteAgentInstallSourceLoader } from "./remoteAgentInstallSource.ts";
import { makeRemoteAgentRestart } from "./remoteAgentRestart.ts";
import { RemoteAgentRestartService } from "./remoteAgentRestart.types.ts";
import { remoteAgentOwners } from "./remoteAgentOwners.ts";

export type RemoteAgentHealthResult =
  | { readonly status: "install-required" }
  | {
      readonly status: "upgrade-required";
      readonly currentVersion: string;
      readonly targetVersion: string;
    }
  | {
      readonly status: "ready";
      readonly runtimeSummary?: ServerRemoteAgentRuntimeSummary;
      readonly agentVersion: string;
      readonly buildDigest: string;
      readonly agentEpoch: string;
    };

export interface RemoteAgentHealth {
  readonly verify: (
    executionTargetId: string,
    signal?: AbortSignal,
  ) => Promise<RemoteAgentHealthResult>;
}

export class RemoteAgentHealthService extends ServiceMap.Service<
  RemoteAgentHealthService,
  RemoteAgentHealth
>()("bigbud/remote-agent/RemoteAgentHealth") {}

export interface RemoteAgentInstaller {
  readonly install: (
    executionTargetId: string,
    signal?: AbortSignal,
  ) => Promise<{
    readonly version: string;
    readonly runtimeSummary?: ServerRemoteAgentRuntimeSummary;
  }>;
}

export class RemoteAgentInstallerService extends ServiceMap.Service<
  RemoteAgentInstallerService,
  RemoteAgentInstaller
>()("bigbud/remote-agent/RemoteAgentInstaller") {}

interface RemoteAgentHealthDependencies {
  readonly managedSummary?: typeof remoteAgentAdmission.status;
  readonly managedBinding?: typeof remoteAgentAdmission.resolveBinding;
  readonly binaryPath: string;
  readonly loadInstallSource: (signal?: AbortSignal) => Promise<RemoteAgentInstallSource>;
  readonly resolveArtifact: ReturnType<typeof makeRemoteAgentInstallManager>["resolveArtifact"];
  readonly runIdentityProbe: (executionTargetId: string, command: string) => Promise<string>;
  readonly pool: {
    readonly get: (executionTargetId: string) => Promise<unknown>;
    readonly snapshot: (executionTargetId: string) => {
      readonly agentVersion?: string;
      readonly buildDigest?: string;
      readonly agentEpoch?: string;
    };
  };
}

export function makeRemoteAgentHealth(
  dependencies: RemoteAgentHealthDependencies,
): RemoteAgentHealth {
  return {
    verify: async (executionTargetId, signal) => {
      const binding = await dependencies.managedBinding?.(executionTargetId);
      if (binding) {
        await dependencies.pool.get(executionTargetId);
        const snapshot = dependencies.pool.snapshot(executionTargetId);
        if (
          snapshot.agentEpoch !== binding.expectedEpoch ||
          snapshot.buildDigest !== binding.runtime.buildDigest
        ) {
          throw new Error(
            "Remote runtime continuity is unavailable; existing owners remain pinned.",
          );
        }
        return {
          status: "ready",
          agentVersion: binding.runtime.version,
          buildDigest: binding.runtime.buildDigest,
          agentEpoch: binding.expectedEpoch,
          ...(dependencies.managedSummary
            ? { runtimeSummary: await dependencies.managedSummary(executionTargetId) }
            : {}),
        };
      }
      const checkOutput = await dependencies.runIdentityProbe(
        executionTargetId,
        buildRemoteAgentIdentityProbeCommand(dependencies.binaryPath),
      );
      if (checkOutput.trim() === "missing") {
        return { status: "install-required" };
      }
      const installedIdentity = parseRemoteAgentCheckOutput(checkOutput);
      const source = await dependencies.loadInstallSource(signal);
      const { artifact } = await dependencies.resolveArtifact({
        executionTargetId,
        source,
        verifySignature: true,
      });
      if (!remoteAgentIdentityMatches(installedIdentity, artifact)) {
        return {
          status: "upgrade-required",
          currentVersion: installedIdentity.version,
          targetVersion: artifact.version,
        };
      }
      try {
        await dependencies.pool.get(executionTargetId);
      } catch (error) {
        if (
          error instanceof RemoteAgentConnectionError &&
          error.code === "UNSUPPORTED_PROTOCOL_MAJOR"
        ) {
          return {
            status: "upgrade-required",
            currentVersion: installedIdentity.version,
            targetVersion: artifact.version,
          };
        }
        throw error;
      }
      const snapshot = dependencies.pool.snapshot(executionTargetId);
      if (!snapshot.agentVersion || !snapshot.buildDigest || !snapshot.agentEpoch) {
        throw new Error("Remote agent handshake did not return complete identity metadata.");
      }
      if (
        snapshot.agentVersion !== artifact.version ||
        snapshot.buildDigest !== artifact.buildDigest
      ) {
        return {
          status: "upgrade-required",
          currentVersion: snapshot.agentVersion,
          targetVersion: artifact.version,
        };
      }
      return {
        status: "ready",
        agentVersion: snapshot.agentVersion,
        buildDigest: snapshot.buildDigest,
        agentEpoch: snapshot.agentEpoch,
      };
    },
  };
}

export function isRemoteAgentConfigured(): boolean {
  return resolveRemoteAgentConfiguration().transport === "agent";
}

interface RemoteAgentServerServicesDependencies {
  readonly binaryPath: string;
  readonly installManager?: {
    readonly resolveArtifact: RemoteAgentHealthDependencies["resolveArtifact"];
    readonly install: (input: {
      readonly executionTargetId: string;
      readonly source: RemoteAgentInstallSource;
      readonly signal?: AbortSignal;
    }) => Promise<{
      readonly artifact: RemoteAgentArtifact;
      readonly runtimeSummary?: ServerRemoteAgentRuntimeSummary;
    }>;
    readonly cleanup?: (target: string) => Promise<unknown>;
  };
  readonly resolveInstallSourceLoader?: () => RemoteAgentInstallSourceLoader;
  readonly beginRetirement?: (executionTargetId: string, generation: string) => Promise<() => void>;
  readonly runIdentityProbe: (executionTargetId: string, command: string) => Promise<string>;
  readonly pool: RemoteAgentHealthDependencies["pool"] & {
    readonly close: (executionTargetId: string) => void;
    readonly admitReplacement?: (
      executionTargetId: string,
      replacement: import("./remoteAgentConnectionPool.ts").RemoteAgentRuntimeBinding,
      retired: import("./remoteAgentConnectionPool.ts").RemoteAgentRuntimeBinding,
    ) => Promise<unknown>;
    readonly closeBound?: (
      executionTargetId: string,
      binding: import("./remoteAgentConnectionPool.ts").RemoteAgentRuntimeBinding,
    ) => void;
    readonly reconcileRuntimeResources?: (
      executionTargetId: string,
      binding: import("./remoteAgentConnectionPool.ts").RemoteAgentRuntimeBinding,
    ) => void;
  };
}

export function makeRemoteAgentServerServices(
  dependencies: RemoteAgentServerServicesDependencies,
): {
  readonly health: RemoteAgentHealth;
  readonly installer: RemoteAgentInstaller;
  readonly updateCoordinator: RemoteAgentUpdateCoordinatorShape;
  readonly restart: import("./remoteAgentRestart.ts").RemoteAgentRestartServiceShape;
} {
  const installManager =
    dependencies.installManager ??
    makeRemoteAgentInstallManager(
      dependencies.beginRetirement ? { beginRetirement: dependencies.beginRetirement } : {},
    );
  const loadInstallSource = (
    dependencies.resolveInstallSourceLoader ?? (() => loadProcessScopedRemoteAgentInstallSource)
  )();
  const health = makeRemoteAgentHealth({
    ...(dependencies.binaryPath === "$HOME/.bigbud/agent/bin/current" &&
    !dependencies.installManager
      ? {
          managedBinding: remoteAgentAdmission.resolveBinding,
          managedSummary: remoteAgentAdmission.status,
        }
      : {}),
    binaryPath: dependencies.binaryPath,
    loadInstallSource,
    resolveArtifact: installManager.resolveArtifact,
    pool: dependencies.pool,
    runIdentityProbe: dependencies.runIdentityProbe,
  });
  const installer = makeRemoteAgentInstaller({
    installManager,
    loadInstallSource,
    pool: dependencies.pool,
  });
  return {
    health,
    installer,
    updateCoordinator: makeRemoteAgentUpdateCoordinator({
      installManager,
      loadInstallSource,
    }),
    restart: makeRemoteAgentRestart({
      close: (target, binding) => {
        if (binding && dependencies.pool.closeBound) {
          dependencies.pool.closeBound(target, binding);
          return;
        }
        dependencies.pool.close(target);
      },
      reconnect: async (target, replacement, retired) => {
        if (replacement && retired && dependencies.pool.admitReplacement) {
          await dependencies.pool.admitReplacement(target, replacement, retired);
        } else {
          await dependencies.pool.get(target);
        }
      },
      verifyReadiness: (target, runtime) => remoteAgentAdmission.verify(target, runtime),
      ...(dependencies.beginRetirement ? { beginRetirement: dependencies.beginRetirement } : {}),
      reconcileRuntime: async (target, binding) => {
        if (dependencies.pool.reconcileRuntimeResources) {
          dependencies.pool.reconcileRuntimeResources(target, binding);
        } else {
          dependencies.pool.closeBound?.(target, binding);
        }
        try {
          await remoteAgentOwners().reconcileRuntime?.(
            binding.runtime.generation,
            binding.expectedEpoch,
          );
        } catch (cause) {
          if (!(cause instanceof Error) || !cause.message.includes("not initialized")) throw cause;
        }
      },
    }),
  };
}

/**
 * Default live composition for the installed remote agent. Set
 * BIGBUD_REMOTE_AGENT_TRANSPORT=direct-ssh for the diagnostic fallback.
 */
export function makeConfiguredRemoteAgentLayers() {
  const configuration = resolveRemoteAgentConfiguration();
  const composition = getConfiguredRemoteAgentComposition();
  if (!composition) {
    return {
      services: Layer.merge(
        Layer.succeed(RemoteAgentGitExecutorService, makeSshGitExecutor()),
        Layer.succeed(RemoteAgentGitOwnership, "external"),
      ),
      workspace: WorkspaceRuntimeLayerLive,
      ptyResolver: undefined as RemoteAgentPtyResolver | undefined,
      health: undefined as RemoteAgentHealth | undefined,
      enabled: false,
    };
  }

  const { health, installer, updateCoordinator, restart } = makeRemoteAgentServerServices({
    binaryPath: configuration.binaryPath!,
    pool: composition.pool,
    beginRetirement: (executionTargetId, generation) =>
      composition.pool.beginRetirement(executionTargetId, generation),
    runIdentityProbe: async (executionTargetId, command) => {
      const presence = await runSshCommand({
        executionTargetId,
        command: "sh",
        args: ["-lc", command],
        timeoutMs: 30_000,
        maxBufferBytes: 1024,
        outputMode: "error",
      });
      return presence.stdout;
    },
  });
  const services = Layer.mergeAll(
    composition.managed ? RemoteAgentRuntimeBindingsLive : Layer.empty,
    Layer.succeed(RemoteAgentGitOwnership, composition.managed ? "managed" : "external"),
    Layer.succeed(RemoteWorkspaceRuntime, composition.workspaceRuntime),
    Layer.succeed(RemoteAgentGitExecutorService, composition.gitExecutor),
    Layer.succeed(RemoteAgentShellRunner, composition.shellRunner),
    Layer.succeed(RemoteAgentHealthService, health),
    Layer.succeed(RemoteAgentInstallerService, installer),
    Layer.succeed(RemoteAgentUpdateCoordinator, updateCoordinator),
    Layer.succeed(RemoteAgentRestartService, restart),
  );
  return {
    services,
    workspace: makeWorkspaceRuntimeLayer(
      Layer.succeed(RemoteWorkspaceRuntime, composition.workspaceRuntime),
    ),
    ptyResolver: composition.ptyResolver,
    health,
    updateCoordinator,
    restart,
    enabled: true,
  };
}

export function makeRemoteAgentInstaller(input: {
  readonly installManager: {
    readonly install: (input: {
      readonly executionTargetId: string;
      readonly source: RemoteAgentInstallSource;
      readonly signal?: AbortSignal;
    }) => Promise<{
      readonly artifact: { readonly version: string };
      readonly runtimeSummary?: ServerRemoteAgentRuntimeSummary;
    }>;
  };
  readonly loadInstallSource: (signal?: AbortSignal) => Promise<RemoteAgentInstallSource>;
  readonly pool: { readonly close: (executionTargetId: string) => void };
}): RemoteAgentInstaller {
  return {
    install: async (executionTargetId, signal) => {
      const result = await input.installManager.install({
        executionTargetId,
        source: await input.loadInstallSource(signal),
        ...(signal ? { signal } : {}),
      });
      return {
        version: result.artifact.version,
        ...(result.runtimeSummary ? { runtimeSummary: result.runtimeSummary } : {}),
      };
    },
  };
}
