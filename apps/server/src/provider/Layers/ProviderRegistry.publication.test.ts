import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import type { ServerProvider } from "@bigbud/contracts";
import { makeProviderRegistryLive } from "./ProviderRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { makeProviderSnapshotStore } from "../providerSnapshot.store.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { makeTestSettings } from "../../ws/serverSettings.testing.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { ServerConfig } from "../../startup/config.ts";
import { V2ConsentAuthority } from "./OpencodeV2/Application.consent.ts";
import {
  fakePiProviderLayer,
  failingSpawnerLayer,
  mockOpencodeServerManagerLayer,
} from "./ProviderRegistry.test.helpers.ts";

function snapshot(provider: ServerProvider["provider"], ready = false): ServerProvider {
  return buildServerProvider({
    provider,
    enabled: true,
    checkedAt: new Date().toISOString(),
    models: ready
      ? [
          {
            slug: "old-native-model",
            name: "Old native model",
            isCustom: false,
            capabilities: null,
          },
        ]
      : [],
    probe: {
      installed: ready,
      version: ready ? "2.0.26" : null,
      status: ready ? "ready" : "warning",
      auth: { status: ready ? "authenticated" : "unknown" },
      message: ready ? "native ready" : "Consent required",
    },
  });
}

for (const race of ["cached-and-buffered", "collection-await"] as const) {
  it(`real registry rejects copied native authority after ${race} revoke/regrant while a peer remains unchanged`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const settings = yield* makeTestSettings({
            providers: { opencodeV2: { enabled: true, nativeServiceTrust: "host-user-v1" } },
          });
          const authority = new V2ConsentAuthority(settings);
          yield* Effect.addFinalizer(() => Effect.sync(() => authority.close()));
          const store = yield* makeProviderSnapshotStore(snapshot("opencodeV2"));
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          let pauseCollection = false;
          const peer = snapshot("cliProxy", true);
          const peerRead = Effect.gen(function* () {
            if (pauseCollection) {
              pauseCollection = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return peer;
          });
          const layer = makeProviderRegistryLive({
            piProviderLayer: fakePiProviderLayer,
            optionalRegistrations: [
              {
                provider: "opencodeV2",
                service: {
                  getSnapshot: store.getSnapshot,
                  refresh: store.getSnapshot,
                  refreshWithRecovery: () => store.getSnapshot,
                  streamChanges: store.streamChanges,
                },
              },
              {
                provider: "cliProxy",
                service: {
                  getSnapshot: peerRead,
                  refresh: peerRead,
                  refreshWithRecovery: () => peerRead,
                  streamChanges: Stream.empty,
                },
              },
            ],
          }).pipe(
            Layer.provideMerge(Layer.succeed(ServerSettingsService, settings)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "registry-publication-" }),
            ),
            Layer.provideMerge(mockOpencodeServerManagerLayer),
            Layer.provideMerge(failingSpawnerLayer("fixture-only missing CLI")),
            Layer.provideMerge(NodeServices.layer),
          );
          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            yield* Effect.sleep("30 millis");
            const received: ReadonlyArray<ServerProvider>[] = [];
            const blocked = yield* Deferred.make<void>(),
              deliver = yield* Deferred.make<void>();
            let holdDelivery = race === "cached-and-buffered";
            yield* Stream.runForEach(registry.streamChanges, (values) => {
              if (holdDelivery) {
                holdDelivery = false;
                return Deferred.succeed(blocked, undefined).pipe(
                  Effect.andThen(Deferred.await(deliver)),
                  Effect.asVoid,
                );
              }
              return Effect.sync(() => received.push(values));
            }).pipe(Effect.forkScoped);
            yield* Effect.sleep("10 millis");
            yield* store.publish(snapshot("opencodeV2", true), authority.capture().assertCurrent);
            yield* registry.refresh("opencodeV2");
            yield* Effect.sleep("20 millis");
            received.length = 0;
            let pending: Fiber.Fiber<ReadonlyArray<ServerProvider>> | undefined;
            if (race === "collection-await") {
              pauseCollection = true;
              pending = yield* registry.refresh("opencodeV2").pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
            } else {
              yield* Deferred.await(blocked);
              yield* store.publish(
                { ...snapshot("opencodeV2", true), message: "buffered native ready" },
                authority.capture().assertCurrent,
              );
              yield* Effect.sleep("20 millis");
            }
            yield* settings.updateSettings({
              providers: { opencodeV2: { nativeServiceTrust: null } },
            });
            yield* settings.updateSettings({
              providers: { opencodeV2: { nativeServiceTrust: "host-user-v1" } },
            });
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.succeed(deliver, undefined);
            const collected = pending ? yield* Fiber.join(pending) : yield* registry.getProviders;
            const cached = yield* registry.getProviders;
            yield* Effect.sleep("30 millis");
            for (const values of [collected, cached, ...received]) {
              const native = values.find((value) => value.provider === "opencodeV2")!;
              expect(native.models).toEqual([]);
              expect(native.auth).toEqual({ status: "unknown" });
              expect(native.status).not.toBe("ready");
              expect(values.find((value) => value.provider === "cliProxy")?.models).toEqual(
                peer.models,
              );
            }
          }).pipe(Effect.provide(layer));
        }),
      ),
    );
  });
}
