import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProvider } from "@bigbud/contracts";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { expect, it } from "vitest";
import { ServerConfig } from "../../startup/config";
import { ServerSettingsService } from "../../ws/serverSettings";
import { DiscoveryRegistry } from "../Services/DiscoveryRegistry";
import { ProviderRegistry } from "../Services/ProviderRegistry";
import { DiscoveryRegistryLive } from "./DiscoveryRegistry";
import { opencodeAgentSystemHash } from "../opencodeAgentSource.ts";

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
    nativeAgents: [
      { id: "native-review", name: "Native Review" },
      {
        id: "babysitter",
        name: "babysitter",
        systemPromptHash: opencodeAgentSystemHash("Watch the task."),
      },
    ],
    skills: [{ name: "Native Skill", path: "/native/skills/example/SKILL.md", enabled: true }],
  };
  const { catalog, sourcePath } = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "native-discovery-source-" });
        const sourcePath = path.join(cwd, ".opencode/agents/babysitter.md");
        yield* fs.makeDirectory(path.dirname(sourcePath), { recursive: true });
        yield* fs.writeFileString(sourcePath, "---\nmode: subagent\n---\n\nWatch the task.\n");
        const layer = DiscoveryRegistryLive.pipe(
          Layer.provide(
            Layer.succeed(ProviderRegistry, {
              getProviders: Effect.succeed([provider]),
              streamChanges: Stream.never,
            } as unknown as typeof ProviderRegistry.Service),
          ),
          Layer.provide(ServerSettingsService.layerTest()),
          Layer.provide(ServerConfig.layerTest(cwd, { prefix: "native-discovery-test-" })),
          Layer.provide(NodeServices.layer),
        );
        const catalog = yield* Effect.gen(function* () {
          const registry = yield* DiscoveryRegistry;
          return yield* registry.getCatalog;
        }).pipe(Effect.provide(layer));
        return { catalog, sourcePath };
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
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
  expect(catalog.agents).toContainEqual(
    expect.objectContaining({
      provider: "opencodeV2",
      name: "babysitter",
      source: "project",
      sourcePath,
    }),
  );
});
