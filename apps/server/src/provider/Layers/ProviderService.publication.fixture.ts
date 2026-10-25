import { Effect, Layer, type Scope } from "effect";
import { ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderTurnLivenessRepository } from "../../persistence/Services/ProviderTurnLiveness.ts";
import { ProviderTurnLivenessRepositoryLive } from "../../persistence/Layers/ProviderTurnLiveness.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeTestSettings } from "../../ws/serverSettings.testing.ts";
import { makeFakeCodexAdapter } from "./ProviderService.test.helpers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { V2ConsentAuthority } from "./OpencodeV2/Application.consent.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";

/** Real canonical service/SQL observation with deterministic pauses and a non-V2 peer. */
export function withCanonicalPublicationFixture<A, E>(
  run: (fixture: {
    service: typeof ProviderService.Service;
    liveness: typeof ProviderTurnLivenessRepository.Service;
    native: ReturnType<typeof makeFakeCodexAdapter>;
    peer: ReturnType<typeof makeFakeCodexAdapter>;
    settings: typeof ServerSettingsService.Service;
    authority: V2ConsentAuthority;
  }) => Effect.Effect<A, E, Scope.Scope>,
  options?: {
    afterObserve?: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    logger?: EventNdjsonLogger;
  },
) {
  const native = makeFakeCodexAdapter("opencodeV2");
  const peer = makeFakeCodexAdapter();
  const settings = Effect.runSync(
    makeTestSettings({
      providers: { opencodeV2: { enabled: true, nativeServiceTrust: "host-user-v1" } },
    }),
  );
  const authority = new V2ConsentAuthority(settings);
  const repositories = Layer.merge(
    ProviderSessionRuntimeRepositoryLive,
    ProviderTurnLivenessRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
  const observation = Layer.effect(
    ProviderTurnLivenessRepository,
    Effect.gen(function* () {
      const repo = yield* ProviderTurnLivenessRepository;
      return {
        ...repo,
        observeEvent: (event: ProviderRuntimeEvent, meaningful: boolean) =>
          repo
            .observeEvent(event, meaningful)
            .pipe(Effect.andThen(options?.afterObserve?.(event) ?? Effect.void)),
        claimTerminal: (input: Parameters<typeof repo.claimTerminal>[0]) =>
          repo
            .claimTerminal(input)
            .pipe(
              Effect.tap(
                () =>
                  options?.afterObserve?.({ provider: input.provider } as ProviderRuntimeEvent) ??
                  Effect.void,
              ),
            ),
      };
    }),
  ).pipe(Layer.provideMerge(repositories));
  const layer = makeProviderServiceLive({
    ...(options?.logger ? { canonicalEventLogger: options.logger } : {}),
  }).pipe(
    Layer.provideMerge(observation),
    Layer.provide(ProviderSessionDirectoryLive.pipe(Layer.provide(repositories))),
    Layer.provide(
      Layer.succeed(ProviderAdapterRegistry, {
        listProviders: () => Effect.succeed(["opencodeV2", "codex"]),
        getByProvider: (provider) =>
          Effect.succeed(provider === "opencodeV2" ? native.adapter : peer.adapter),
      }),
    ),
    Layer.provide(Layer.succeed(ServerSettingsService, settings)),
    Layer.provide(AnalyticsService.layerTest),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => authority.close()));
        const service = yield* ProviderService;
        const liveness = yield* ProviderTurnLivenessRepository;
        yield* insertProjectionThreadParent({
          sql: yield* SqlClient.SqlClient,
          threadId: ThreadId.makeUnsafe("canonical-owned"),
        });
        return yield* run({ service, liveness, native, peer, settings, authority });
      }).pipe(Effect.provide(layer)),
    ),
  );
}
