/**
 * Installs the runtime inputs of delegated model choice beside the thread-tool dispatcher (D9).
 * One server-level layer, not the per-connection RPC context, so a closing mobile connection can
 * never uninstall them (plan A5).
 *
 * @module ThreadOrchestrationTools.modelSources
 */
import { Effect, Layer } from "effect";

import type { DesktopSupervisorDeliveryShape } from "../desktop-supervisor/desktopSupervisorDelivery.types.ts";
import { DesktopSupervisorDelivery } from "../desktop-supervisor/desktopSupervisorDelivery.ts";
import type { ProjectionThreadRepositoryShape } from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import type { ProviderRegistryShape } from "../provider/Services/ProviderRegistry.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../ws/serverSettings.ts";
import {
  setThreadToolModelSources,
  type ThreadToolModelSources,
} from "./ThreadOrchestrationToolDispatcher.ts";

export function makeThreadToolModelSources(input: {
  readonly providerRegistry: Pick<ProviderRegistryShape, "getProviders">;
  readonly serverSettings: Pick<ServerSettingsShape, "getSettings">;
  readonly projectionThreadRepository: Pick<
    ProjectionThreadRepositoryShape,
    "listRecentModelSelections"
  >;
  readonly delivery: Pick<DesktopSupervisorDeliveryShape, "hasOpenConsumer">;
}): ThreadToolModelSources {
  return {
    // Cached snapshots only: the tool path never refreshes or probes providers (A1).
    getProviders: input.providerRegistry.getProviders,
    getSettings: input.serverSettings.getSettings,
    listRecent: (limit) => input.projectionThreadRepository.listRecentModelSelections({ limit }),
    hasInteractiveClient: () => input.delivery.hasOpenConsumer(),
  };
}

export const ThreadToolModelSourcesLive = Layer.effectDiscard(
  Effect.gen(function* () {
    setThreadToolModelSources(
      makeThreadToolModelSources({
        providerRegistry: yield* ProviderRegistry,
        serverSettings: yield* ServerSettingsService,
        projectionThreadRepository: yield* ProjectionThreadRepository,
        delivery: yield* DesktopSupervisorDelivery,
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => setThreadToolModelSources(null)));
  }),
);
