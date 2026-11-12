import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProvider } from "@bigbud/contracts";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Exit, Layer, Scope, Stream } from "effect";

import { makeProviderRegistryLive } from "./ProviderRegistry";
import { OpencodeServerManager } from "../Services/Opencode/ServerManager";
import { PiProvider } from "../Services/Pi/Provider";
import { ProviderRegistry } from "../Services/ProviderRegistry";
import type { ProviderRegistration } from "../ProviderRegistration";
import type { ServerProviderShape } from "../Services/ServerProvider";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings";
import {
  failingSpawnerLayer,
  mockOpencodeServerManagerLayer,
} from "./ProviderRegistry.test.helpers";

function snapshot(
  provider: ServerProvider["provider"],
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    provider,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-12T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function staticProvider(value: ServerProvider): ServerProviderShape {
  return {
    getSnapshot: Effect.succeed(value),
    refresh: Effect.succeed(value),
    refreshWithRecovery: () => Effect.succeed(value),
    streamChanges: Stream.empty,
  };
}

const publishedProviders = (input: {
  readonly pi: ServerProvider;
  readonly optional: ReadonlyArray<ServerProvider>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const optionalRegistrations: ReadonlyArray<ProviderRegistration> = input.optional.map(
      (value) => ({ provider: value.provider, service: staticProvider(value) }),
    );
    const registryLayer = makeProviderRegistryLive({
      optionalRegistrations,
      piProviderLayer: Layer.succeed(PiProvider, staticProvider(input.pi)),
    }).pipe(
      Layer.provideMerge(Layer.succeed(ServerSettingsService, yield* ServerSettingsService)),
      Layer.provideMerge(Layer.succeed(ServerConfig, yield* ServerConfig)),
      Layer.provideMerge(Layer.succeed(OpencodeServerManager, yield* OpencodeServerManager)),
      Layer.provideMerge(failingSpawnerLayer("spawn ENOENT")),
    );
    const services = yield* Layer.build(registryLayer).pipe(Scope.provide(scope));
    const providers = yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry;
      return yield* registry.getProviders;
    }).pipe(Effect.provide(services));
    return (provider: ServerProvider["provider"]) =>
      providers.find((value) => value.provider === provider)?.supportsLocalRuntimeRemoteWorkspace;
  });

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    ServerSettingsService.layerTest(),
    mockOpencodeServerManagerLayer,
    ServerConfig.layerTest("/tmp", { prefix: "provider-registry-remote-workspace-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
)("ProviderRegistry remote workspace capability", (it) => {
  describe("published supportsLocalRuntimeRemoteWorkspace", () => {
    it.effect("is a capability that does not depend on provider health", () =>
      Effect.gen(function* () {
        const published = yield* publishedProviders({
          pi: snapshot("pi", { auth: { status: "unknown" } }),
          optional: [
            snapshot("opencodeV2", {
              status: "warning",
              auth: { status: "unknown" },
              initialProbeComplete: false,
            }),
            snapshot("muse"),
          ],
        });
        assert.strictEqual(published("pi"), true);
        assert.strictEqual(published("opencodeV2"), true);
        assert.strictEqual(published("muse"), false);
      }),
    );

    it.effect("keeps an explicit snapshot opt-out", () =>
      Effect.gen(function* () {
        const published = yield* publishedProviders({
          pi: snapshot("pi", { status: "error", installed: false }),
          optional: [snapshot("opencodeV2", { supportsLocalRuntimeRemoteWorkspace: false })],
        });
        assert.strictEqual(published("pi"), true);
        assert.strictEqual(published("opencodeV2"), false);
      }),
    );
  });
});
