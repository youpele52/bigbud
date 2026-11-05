import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { deriveServerPaths, ensureServerDirectories, ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { DiscoveryRegistry } from "../Services/DiscoveryRegistry.ts";
import { DiscoveryRegistryLive } from "./DiscoveryRegistry.ts";

it.layer(NodeServices.layer)("marketplace state retirement", (it) => {
  it.effect("does not create marketplace storage during directory initialization", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "retired-marketplace-" });
      const paths = yield* deriveServerPaths(baseDir, undefined);
      yield* ensureServerDirectories(paths);
      assert.isFalse(yield* fs.exists(path.join(paths.stateDir, "plugins")));
    }),
  );

  it.effect("leaves old installations untouched and inactive while discovering direct skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "retired-installation-" });
      const cwd = path.join(baseDir, "project");
      const paths = yield* deriveServerPaths(baseDir, undefined);
      const root = path.join(paths.stateDir, "plugins");
      const skillPath = path.join(
        root,
        "packages",
        "openai-public--example",
        "old",
        "skills",
        "example",
        "SKILL.md",
      );
      const registry = '{"installations":[{"pluginId":"openai-public:example","revision":"old"}]}';
      const oldSkill = "---\nname: retired-example\n---\nOld marketplace instructions.";
      yield* fs.makeDirectory(path.dirname(skillPath), { recursive: true });
      yield* fs.writeFileString(skillPath, oldSkill);
      yield* fs.writeFileString(path.join(root, "registry.json"), registry);
      const directSkillPath = path.join(cwd, ".agents", "skills", "direct", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(directSkillPath), { recursive: true });
      yield* fs.writeFileString(
        directSkillPath,
        "---\nname: direct-example\n---\nDirect skill instructions.",
      );

      const catalog = yield* Effect.gen(function* () {
        const discovery = yield* DiscoveryRegistry;
        return yield* discovery.getCatalog;
      }).pipe(
        Effect.provide(
          DiscoveryRegistryLive.pipe(
            Layer.provide(ServerConfig.layerTest(cwd, baseDir)),
            Layer.provide(ServerSettingsService.layerTest()),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      assert.isFalse(catalog.skills.some((skill) => skill.sourcePath?.startsWith(root)));
      assert.isTrue(catalog.skills.some((skill) => skill.name === "direct-example"));
      assert.equal(yield* fs.readFileString(path.join(root, "registry.json")), registry);
      assert.equal(yield* fs.readFileString(skillPath), oldSkill);
    }),
  );
});
