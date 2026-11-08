/**
 * Provider composition for the server: the provider service with every adapter, the session
 * directory, the provider registry and the Claude refresh reactor. Split from `server.ts` by
 * concern; the remote-agent layers are passed in so the PTY resolver is shared.
 *
 * @module server.providerLayers
 */
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "./startup/config";
import { makeProviderLogSecurity } from "./server.providerLogs.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { ProviderTurnLivenessRepositoryLive } from "./persistence/Layers/ProviderTurnLiveness";
import { makeCodexAdapterLive } from "./provider/Layers/Codex/Adapter";
import { makeClaudeAdapterLive } from "./provider/Layers/Claude/Adapter";
import { OptionalProviderCompositionLive } from "./provider/Layers/OptionalProviderComposition.ts";
import { makeCopilotAdapterLive } from "./provider/Layers/Copilot/Adapter";
import { makeCursorAdapterLive } from "./provider/Layers/Cursor/Adapter";
import { makeDevinAdapterLive } from "./provider/Layers/Devin/Adapter";
import { makePiAdapterLive } from "./provider/Layers/Pi/Adapter";
import { makeProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { makeProviderRegistryLive } from "./provider/Layers/ProviderRegistry";
import { ClaudeProviderRefreshReactorLive } from "./provider/Layers/ClaudeProviderRefreshReactor";
import {
  OptionalProviderRegistrations,
  type OptionalProviderRegistration,
} from "./provider/ProviderRegistration";
import {
  isProviderRegistered,
  makeProviderCapabilitiesResolver,
} from "./provider/providerCapabilities";
import type { makeConfiguredRemoteAgentLayers } from "./remote-agent/remoteAgentServerLayer.ts";
import * as Recovery from "./server.recoveryLayers.ts";

type ConfiguredRemoteAgentLayers = ReturnType<typeof makeConfiguredRemoteAgentLayers>;

const makeProviderLayerLive = (
  optionalRegistrations: ReadonlyArray<OptionalProviderRegistration>,
  configuredRemoteAgentLayers: ConfiguredRemoteAgentLayers,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { baseDir, devUrl, providerEventLogPath } = yield* ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const { canonicalEventLogger, nativeEventLogger, settleThreadLogs } =
        yield* makeProviderLogSecurity({ baseDir, devUrl, providerEventLogPath, sql });
      const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(ProviderSessionRuntimeRepositoryLive),
      );
      const codexAdapterLayer = makeCodexAdapterLive(
        nativeEventLogger ? { nativeEventLogger } : undefined,
      );
      const claudeAdapterLayer = makeClaudeAdapterLive(
        nativeEventLogger ? { nativeEventLogger } : undefined,
      );
      const copilotAdapterLayer = makeCopilotAdapterLive(
        nativeEventLogger ? { nativeEventLogger } : undefined,
      );
      const cursorAdapterLayer = makeCursorAdapterLive({
        ...(nativeEventLogger ? { nativeEventLogger } : {}),
        ...(configuredRemoteAgentLayers.ptyResolver
          ? { remoteAgentPtyResolver: configuredRemoteAgentLayers.ptyResolver }
          : {}),
      });
      const devinAdapterLayer = makeDevinAdapterLive({
        ...(nativeEventLogger ? { nativeEventLogger } : {}),
        ...(configuredRemoteAgentLayers.ptyResolver
          ? { remoteAgentPtyResolver: configuredRemoteAgentLayers.ptyResolver }
          : {}),
      });
      const piAdapterLayer = makePiAdapterLive(
        nativeEventLogger ? { nativeEventLogger } : undefined,
      );
      const adapterRegistryLayer = makeProviderAdapterRegistryLive({
        optionalRegistrations: optionalRegistrations.map((registration) => ({
          provider: registration.provider,
          service: registration.adapterService,
        })),
      }).pipe(
        Layer.provide(codexAdapterLayer),
        Layer.provide(claudeAdapterLayer),
        Layer.provide(copilotAdapterLayer),
        Layer.provide(cursorAdapterLayer),
        Layer.provide(devinAdapterLayer),
        Layer.provide(piAdapterLayer),
        Layer.provideMerge(providerSessionDirectoryLayer),
      );
      const getProviderCapabilities = makeProviderCapabilitiesResolver(optionalRegistrations);
      return makeProviderServiceLive({
        ...(canonicalEventLogger ? { canonicalEventLogger } : {}),
        settleThreadLogs,
        getProviderCapabilities,
        isProviderComposed: (provider) => isProviderRegistered(provider, optionalRegistrations),
      }).pipe(
        Layer.provideMerge(adapterRegistryLayer),
        Layer.provide(providerSessionDirectoryLayer),
        Layer.provide(ProviderTurnLivenessRepositoryLive),
        Layer.provide(Recovery.RecoveryPersistenceLayerLive),
      );
    }),
  );

export const makeProviderInfrastructureLayerLive = (
  configuredRemoteAgentLayers: ConfiguredRemoteAgentLayers,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const optionalRegistrations = yield* OptionalProviderRegistrations;
      return ClaudeProviderRefreshReactorLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            makeProviderLayerLive(optionalRegistrations, configuredRemoteAgentLayers),
            makeProviderRegistryLive({
              optionalRegistrations: optionalRegistrations.map((registration) => ({
                provider: registration.provider,
                service: registration.providerService,
              })),
            }),
          ),
        ),
      );
    }),
  ).pipe(Layer.provide(OptionalProviderCompositionLive));
