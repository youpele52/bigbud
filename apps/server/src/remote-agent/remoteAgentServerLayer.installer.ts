import type { ServerRemoteAgentRuntimeSummary } from "@bigbud/contracts/server/server.ts";
import { remoteAgentArtifactBuildId } from "./remoteAgentRuntime.ts";

import type { RemoteAgentInstaller } from "./remoteAgentServerLayer.ts";
import type { RemoteAgentInstallSource } from "./remoteAgentInstallManager.ts";
import type { RemoteAgentRemovalResult } from "./remoteAgentInstall.remove.ts";
import { beginRemoteAgentTargetRemoval } from "./remoteAgentConnectionPool.removal.ts";
import {
  buildRemoteAgentManualInstall,
  remoteAgentManualInstallVersion,
} from "./remoteAgentManualInstall.ts";

export function makeRemoteAgentInstaller(input: {
  readonly installManager: {
    readonly install: (input: {
      readonly executionTargetId: string;
      readonly source: RemoteAgentInstallSource;
      readonly signal?: AbortSignal;
    }) => Promise<{
      readonly artifact: {
        readonly version: string;
        readonly sha256: string;
        readonly targetTriple: string;
      };
      readonly runtimeSummary?: ServerRemoteAgentRuntimeSummary;
      readonly placement?: "upload" | "managed" | "inbox";
      readonly inboxConflict?: boolean;
    }>;
    readonly remove?: (input: {
      readonly executionTargetId: string;
      readonly closeLocalConnections?: () => void;
      readonly markRemoving?: () => () => void;
    }) => Promise<RemoteAgentRemovalResult>;
  };
  readonly loadInstallSource: (signal?: AbortSignal) => Promise<RemoteAgentInstallSource>;
  readonly pool: { readonly close: (executionTargetId: string) => void };
  readonly releaseRepository?: string | undefined;
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
        buildId: remoteAgentArtifactBuildId(result.artifact),
        ...(result.runtimeSummary ? { runtimeSummary: result.runtimeSummary } : {}),
        ...(result.placement ? { placement: result.placement } : {}),
        ...(result.inboxConflict ? { inboxConflict: true } : {}),
      };
    },
    ...(input.installManager.remove
      ? {
          remove: (executionTargetId: string) =>
            input.installManager.remove!({
              executionTargetId,
              // This app's pooled connections must not keep the agent busy during removal.
              closeLocalConnections: () => input.pool.close(executionTargetId),
              // The pool must not redial the build being deleted.
              markRemoving: () => beginRemoteAgentTargetRemoval(executionTargetId),
            }),
        }
      : {}),
    manualInstall: async (executionTargetId, signal) =>
      buildRemoteAgentManualInstall({
        executionTargetId,
        version: remoteAgentManualInstallVersion(await input.loadInstallSource(signal)),
        repository: input.releaseRepository,
      }),
  };
}
