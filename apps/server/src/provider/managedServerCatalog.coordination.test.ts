import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeManagedServerProvider } from "./makeManagedServerProvider";
import { discoverManagedServerCatalog } from "./managedServerCatalog";
import { runCoordinatedProviderProbe } from "./providerProbeCoordinator";

function snapshot(provider: "opencode" | "kilocode", live = false): ServerProvider {
  return {
    provider,
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-30T00:00:00.000Z",
    models: [
      { slug: live ? "live" : "fallback", name: "Model", isCustom: false, capabilities: null },
    ],
    modelDiscovery: {
      status: live ? "live" : "unavailable",
      source: live ? "source" : "fallback",
      durationMs: 0,
    },
    slashCommands: [],
    skills: [],
  };
}

it.effect(
  "OpenCode and KiloCode catalog wrappers finish while the third probe permit is occupied",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thirdStarted = yield* Deferred.make<void>();
        yield* runCoordinatedProviderProbe(
          Deferred.succeed(thirdStarted, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(thirdStarted);

        const bothStarted = yield* Deferred.make<void>();
        const releaseAvailability = yield* Deferred.make<void>();
        let availabilityCalls = 0;
        let catalogCalls = 0;
        const make = (provider: "opencode" | "kilocode") =>
          makeManagedServerProvider({
            initialSnapshot: snapshot(provider),
            getSettings: Effect.succeed(true),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            recoverModelDiscovery: true,
            refreshInterval: "1 hour",
            checkProvider: Effect.gen(function* () {
              if (++availabilityCalls === 2) yield* Deferred.succeed(bothStarted, undefined);
              yield* Deferred.await(releaseAvailability);
              return snapshot(provider);
            }),
            // Exercise the production catalog wrapper, not a synthetic discovery callback.
            discoverSnapshot: ({ snapshot: baseSnapshot, publishSnapshot }) =>
              discoverManagedServerCatalog({
                provider,
                baseSnapshot,
                catalogSnapshot: Effect.sync(() => {
                  catalogCalls++;
                  return snapshot(provider, true);
                }),
                publishSnapshot,
              }),
          });
        const opencode = yield* make("opencode");
        const kilocode = yield* make("kilocode");
        yield* Deferred.await(bothStarted);
        yield* Deferred.succeed(releaseAvailability, undefined);
        yield* TestClock.adjust(1);
        for (const service of [opencode, kilocode]) {
          const result = yield* service.getSnapshot;
          assert.strictEqual(result.initialProbeComplete, true);
          assert.strictEqual(result.modelDiscovery?.status, "live");
          assert.strictEqual(result.models[0]?.slug, "live");
        }
        assert.strictEqual(availabilityCalls, 2);
        assert.strictEqual(catalogCalls, 2);
      }),
    ),
);
