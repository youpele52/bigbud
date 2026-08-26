import { Layer, ServiceMap } from "effect";

import { makeSshGitExecutor } from "../git/Layers/GitCore.ssh.ts";
import { RemoteAgentGitExecutorService } from "./remoteAgentGit.ts";
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
import { loadRemoteAgentInstallSource } from "./remoteAgentInstallSource.ts";
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

export type RemoteAgentHealthResult =
  | { readonly status: "install-required" }
  | {
      readonly status: "upgrade-required";
      readonly currentVersion: string;
      readonly targetVersion: string;
    }
  | {
      readonly status: "ready";
      readonly agentVersion: string;
      readonly buildDigest: string;
      readonly agentEpoch: string;
    };

export interface RemoteAgentHealth {
  readonly verify: (executionTargetId: string) => Promise<RemoteAgentHealthResult>;
}

export class RemoteAgentHealthService extends ServiceMap.Service<
  RemoteAgentHealthService,
  RemoteAgentHealth
>()("bigbud/remote-agent/RemoteAgentHealth") {}

export interface RemoteAgentInstaller {
  readonly install: (executionTargetId: string) => Promise<{
    readonly version: string;
  }>;
}

export class RemoteAgentInstallerService extends ServiceMap.Service<
  RemoteAgentInstallerService,
  RemoteAgentInstaller
>()("bigbud/remote-agent/RemoteAgentInstaller") {}

interface RemoteAgentHealthDependencies {
  readonly binaryPath: string;
  readonly loadInstallSource: () => Promise<RemoteAgentInstallSource>;
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

function cacheSuccessfulInstallSource(
  load: () => Promise<RemoteAgentInstallSource>,
): () => Promise<RemoteAgentInstallSource> {
  let cached: Promise<RemoteAgentInstallSource> | undefined;
  return async () => {
    const pending = cached ?? load();
    cached = pending;
    try {
      return await pending;
    } catch (error) {
      if (cached === pending) cached = undefined;
      throw error;
    }
  };
}

export function makeRemoteAgentHealth(
  dependencies: RemoteAgentHealthDependencies,
): RemoteAgentHealth {
  return {
    verify: async (executionTargetId) => {
      const checkOutput = await dependencies.runIdentityProbe(
        executionTargetId,
        buildRemoteAgentIdentityProbeCommand(dependencies.binaryPath),
      );
      if (checkOutput.trim() === "missing") {
        return { status: "install-required" };
      }
      const installedIdentity = parseRemoteAgentCheckOutput(checkOutput);
      const source = await dependencies.loadInstallSource();
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

/**
 * Default live composition for the installed remote agent. Set
 * BIGBUD_REMOTE_AGENT_TRANSPORT=direct-ssh for the diagnostic fallback.
 */
export function makeConfiguredRemoteAgentLayers() {
  const configuration = resolveRemoteAgentConfiguration();
  const composition = getConfiguredRemoteAgentComposition();
  if (!composition) {
    return {
      services: Layer.succeed(RemoteAgentGitExecutorService, makeSshGitExecutor()),
      workspace: WorkspaceRuntimeLayerLive,
      ptyResolver: undefined as RemoteAgentPtyResolver | undefined,
      health: undefined as RemoteAgentHealth | undefined,
      enabled: false,
    };
  }

  const installManager = makeRemoteAgentInstallManager();
  const health = makeRemoteAgentHealth({
    binaryPath: configuration.binaryPath!,
    loadInstallSource: cacheSuccessfulInstallSource(() => loadRemoteAgentInstallSource()),
    resolveArtifact: installManager.resolveArtifact,
    pool: composition.pool,
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
  const installer = makeRemoteAgentInstaller({
    installManager,
    loadInstallSource: loadRemoteAgentInstallSource,
    pool: composition.pool,
  });
  const services = Layer.mergeAll(
    Layer.succeed(RemoteWorkspaceRuntime, composition.workspaceRuntime),
    Layer.succeed(RemoteAgentGitExecutorService, composition.gitExecutor),
    Layer.succeed(RemoteAgentShellRunner, composition.shellRunner),
    Layer.succeed(RemoteAgentHealthService, health),
    Layer.succeed(RemoteAgentInstallerService, installer),
  );
  return {
    services,
    workspace: makeWorkspaceRuntimeLayer(
      Layer.succeed(RemoteWorkspaceRuntime, composition.workspaceRuntime),
    ),
    ptyResolver: composition.ptyResolver,
    health,
    enabled: true,
  };
}

export function makeRemoteAgentInstaller(input: {
  readonly installManager: {
    readonly install: (input: {
      readonly executionTargetId: string;
      readonly source: RemoteAgentInstallSource;
    }) => Promise<{ readonly artifact: { readonly version: string } }>;
  };
  readonly loadInstallSource: () => Promise<RemoteAgentInstallSource>;
  readonly pool: { readonly close: (executionTargetId: string) => void };
}): RemoteAgentInstaller {
  return {
    install: async (executionTargetId) => {
      const result = await input.installManager.install({
        executionTargetId,
        source: await input.loadInstallSource(),
      });
      input.pool.close(executionTargetId);
      return { version: result.artifact.version };
    },
  };
}
