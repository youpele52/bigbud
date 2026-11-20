import { Effect, Stream } from "effect";

import type { ServerProviderShape } from "../../Services/ServerProvider.ts";
import { buildServerProvider } from "../../providerSnapshot.ts";

/** HTTP lease authentication is never represented as model-provider authentication. */
export function makeDormantOpencodeV2Provider(): ServerProviderShape {
  // Matches the dormant registration capabilities: no local runtime against remote workspaces.
  const snapshot = Effect.sync(() => ({
    ...buildServerProvider({
      provider: "opencodeV2",
      enabled: false,
      checkedAt: new Date().toISOString(),
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "Development only. Live generation, recovery, MCP isolation, and full platform/remote conformance are not yet verified.",
      },
    }),
    supportsLocalRuntimeRemoteWorkspace: false,
  }));
  return {
    getSnapshot: snapshot,
    refresh: snapshot,
    refreshWithRecovery: () => snapshot,
    streamChanges: Stream.empty,
  };
}
