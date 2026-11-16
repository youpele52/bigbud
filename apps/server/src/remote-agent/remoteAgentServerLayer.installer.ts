import type { ServerRemoteAgentRuntimeSummary } from "@bigbud/contracts/server/server.ts";
import { remoteAgentArtifactBuildId } from "./remoteAgentRuntime.ts";

import type { RemoteAgentInstaller } from "./remoteAgentServerLayer.ts";
import type { RemoteAgentInstallSource } from "./remoteAgentInstallManager.ts";
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
    manualInstall: async (executionTargetId, signal) =>
      buildRemoteAgentManualInstall({
        executionTargetId,
        version: remoteAgentManualInstallVersion(await input.loadInstallSource(signal)),
        repository: input.releaseRepository,
      }),
  };
}
