import { Layer, ServiceMap } from "effect";

import { makeSshGitExecutor } from "../git/Layers/GitCore.ssh.ts";
import { RemoteAgentGitExecutorService } from "./remoteAgentGit.ts";
import type { RemoteAgentPtyResolver } from "./remoteAgentPtyAdapter.ts";
import { RemoteAgentShellRunner } from "./remoteAgentShell.ts";
import { buildRemoteAgentPresenceProbeCommand } from "./remoteAgentConnection.ts";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";
import { loadRemoteAgentInstallSource } from "./remoteAgentInstallSource.ts";
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

  const health: RemoteAgentHealth = {
    verify: async (executionTargetId: string) => {
      const presence = await runSshCommand({
        executionTargetId,
        command: "sh",
        args: ["-lc", buildRemoteAgentPresenceProbeCommand(configuration.binaryPath!)],
        timeoutMs: 30_000,
        maxBufferBytes: 1024,
        outputMode: "error",
      });
      if (presence.stdout.trim() === "missing") {
        return { status: "install-required" };
      }
      await composition.pool.get(executionTargetId);
      const snapshot = composition.pool.snapshot(executionTargetId);
      if (!snapshot.agentVersion || !snapshot.buildDigest || !snapshot.agentEpoch) {
        throw new Error("Remote agent handshake did not return complete identity metadata.");
      }
      return {
        status: "ready",
        agentVersion: snapshot.agentVersion,
        buildDigest: snapshot.buildDigest,
        agentEpoch: snapshot.agentEpoch,
      };
    },
  };
  const installManager = makeRemoteAgentInstallManager();
  const installer: RemoteAgentInstaller = {
    install: async (executionTargetId) => {
      const result = await installManager.install({
        executionTargetId,
        source: await loadRemoteAgentInstallSource(),
      });
      composition.pool.close(executionTargetId);
      return { version: result.artifact.version };
    },
  };
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
