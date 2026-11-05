import { Effect, Layer } from "effect";

import type {
  OptionalProviderRegistration,
  ProviderCapabilities,
} from "../../ProviderRegistration.ts";
import { MuseAdapter } from "../../Services/Muse/Adapter.ts";
import { MuseProvider } from "../../Services/Muse/Provider.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { MuseSessionBindings } from "../../../persistence/Services/MuseSessionBindings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { MuseSessionBindingsLive } from "../../../persistence/Layers/MuseSessionBindings.ts";
import { createMuseThreadOrchestrationBridge } from "../../../orchestration-tools/museThreadOrchestrationTools.ts";
import { makeMuseAdapterShape } from "./Adapter.ts";
import { makeSdkMuseHostFactory } from "./Client.lifecycle.ts";
import { isMusePlatformQualified } from "./Provider.discovery.ts";
import { MuseProviderLive } from "./Provider.ts";
import { describeMuseError, mapMuseRequestError, museProcessError } from "./Client.errors.ts";

export const MUSE_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  supportsRemoteProviderRuntime: false,
  supportsLocalRuntimeRemoteWorkspace: false,
  toolInjectionMode: "mcp",
  needsBuiltinsDisabled: false,
  compactionBehavior: "unknown",
  tokenUsageSemantics: "unavailable",
  sessionHistorySemantics: "persistent",
};

export const MuseAdapterLive = Layer.effect(
  MuseAdapter,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const bindings = yield* MuseSessionBindings;
    const admissions = yield* ProviderTurnAdmissions;
    return yield* makeMuseAdapterShape({
      hostFactory: makeSdkMuseHostFactory(),
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.muse),
        Effect.mapError((error) => mapMuseRequestError("settings", error)),
      ),
      platformQualified: isMusePlatformQualified(),
      bindings,
      admissions,
      bridgeFactory: (threadId, nativeSessionId) =>
        Effect.tryPromise({
          try: async () => {
            const { bridge, config } = await createMuseThreadOrchestrationBridge({
              stateDir: serverConfig.stateDir,
              threadId,
              host: serverConfig.host,
              port: serverConfig.port,
              providerSessionId: nativeSessionId,
            });
            return {
              config: config.mcpServers as Record<string, unknown>,
              cleanup: bridge.cleanup,
            };
          },
          catch: (error) => museProcessError(threadId, describeMuseError(error), undefined, error),
        }),
    });
  }),
).pipe(Layer.provide(MuseSessionBindingsLive));

export const MuseImplementationLive = Layer.mergeAll(MuseAdapterLive, MuseProviderLive);

export const makeMuseRegistration = Effect.gen(function* () {
  const providerService = yield* MuseProvider;
  const adapterService = yield* MuseAdapter;
  return {
    provider: "muse",
    providerService,
    adapterService,
    capabilities: MUSE_PROVIDER_CAPABILITIES,
  } satisfies OptionalProviderRegistration;
});

/** Registration is always composed; settings (default disabled) and the platform gate control availability. */
