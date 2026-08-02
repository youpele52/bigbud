import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import type { ServerDiscoveredSkill } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";

import { ServerConfig } from "../src/startup/config";
import { ServerSettingsService } from "../src/ws/serverSettings";
import { DiscoveryRegistry } from "../src/provider/Services/DiscoveryRegistry";
import { DiscoveryRegistryLive } from "../src/provider/Layers/DiscoveryRegistry";

// ── Test helpers (mirrored from discovery.integration.test.ts) ───────

const makeStubSettingsLayer = () =>
  Layer.succeed(ServerSettingsService, {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
    streamChanges: Stream.empty,
  });

const makeRegistryLayer = (cwd: string) =>
  DiscoveryRegistryLive.pipe(
    Layer.provideMerge(makeStubSettingsLayer()),
    Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "discovery-bigbud-integration-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const getCatalog = (cwd: string) =>
  Effect.gen(function* () {
    const registry = yield* DiscoveryRegistry;
    return yield* registry.getCatalog;
  }).pipe(Effect.provide(makeRegistryLayer(cwd)));

const writeSkillFile = (
  fs: FileSystem.FileSystem,
  baseDir: string,
  name: string,
  content: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const filePath = path.join(baseDir, name, "SKILL.md");
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, content);
  });

const frontmatter = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSkill body.`;

// ── Integration tests ────────────────────────────────────────────────

describe("DiscoveryRegistry — .bigbud/skills integration", () => {
  it.layer(NodeServices.layer)("discovers .bigbud/skills labelled as the bigbud provider", (it) => {
    it.effect("bigbud project skills are labelled correctly", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-integration-bigbud-" });

        const bigbudSkillsDir = path.join(cwd, ".bigbud/skills");
        yield* writeSkillFile(
          fs,
          bigbudSkillsDir,
          "git-commit",
          frontmatter("git-commit", "Create well-formatted git commits"),
        );
        yield* writeSkillFile(
          fs,
          bigbudSkillsDir,
          "handoff",
          frontmatter("handoff", "Compact the conversation into a handoff doc"),
        );

        const catalog = yield* getCatalog(cwd);
        const skills = catalog.skills as ReadonlyArray<ServerDiscoveredSkill>;
        const projectBigbudSkills = skills.filter(
          (s) => s.provider === "bigbud" && s.sourcePath?.startsWith(cwd),
        );

        assert.strictEqual(projectBigbudSkills.length, 2);
        for (const expected of ["git-commit", "handoff"]) {
          assert.isDefined(
            projectBigbudSkills.find((s) => s.name === expected),
            `should find bigbud skill: ${expected}`,
          );
        }
        for (const s of projectBigbudSkills) {
          assert.strictEqual(s.source, "project");
        }
      }),
    );
  });
});
