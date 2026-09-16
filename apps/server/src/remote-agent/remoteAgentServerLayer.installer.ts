import type { ServerRemoteAgentRuntimeSummary } from "@bigbud/contracts/server/server.ts";

import type { RemoteAgentInstaller } from "./remoteAgentServerLayer.ts";
import type { RemoteAgentInstallSource } from "./remoteAgentInstallManager.ts";

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
