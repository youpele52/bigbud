import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProvider } from "@bigbud/contracts";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import { ServerConfig } from "../../startup/config";
import { ServerSettingsService } from "../../ws/serverSettings";
import { DiscoveryRegistry } from "../Services/DiscoveryRegistry";
import { ProviderRegistry } from "../Services/ProviderRegistry";
import { DiscoveryRegistryLive } from "./DiscoveryRegistry";

it("merges native shared-service agents/skills when provider infrastructure is available to discovery", async () => {
  const provider: ServerProvider = {
    provider: "opencodeV2",
    enabled: true,
    installed: true,
    version: "2.0.24",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-10-09T00:00:00Z",
    models: [],
    slashCommands: [],
    supportsLocalRuntimeRemoteWorkspace: false,
    nativeAgents: [{ id: "native-review", name: "Native Review" }],
    skills: [{ name: "Native Skill", path: "/native/skills/example/SKILL.md", enabled: true }],
  };
  const layer = DiscoveryRegistryLive.pipe(
    Layer.provide(
      Layer.succeed(ProviderRegistry, {
        getProviders: Effect.succeed([provider]),
        streamChanges: Stream.never,
      } as unknown as typeof ProviderRegistry.Service),
    ),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "native-discovery-test-" })),
    Layer.provide(NodeServices.layer),
  );
  const catalog = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* DiscoveryRegistry;
      return yield* registry.getCatalog;
    }).pipe(Effect.provide(layer)),
  );
  expect(catalog.agents).toContainEqual(
    expect.objectContaining({ provider: "opencodeV2", name: "Native Review", source: "config" }),
  );
  expect(catalog.skills).toContainEqual(
    expect.objectContaining({
      provider: "opencodeV2",
      name: "Native Skill",
      sourcePath: "/native/skills/example/SKILL.md",
    }),
  );
});
