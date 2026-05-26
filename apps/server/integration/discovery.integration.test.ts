import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import type { ServerDiscoveredSkill, ServerDiscoveredAgent } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";

import { ServerConfig } from "../src/startup/config";
import { ServerSettingsService } from "../src/ws/serverSettings";
import { DiscoveryRegistry } from "../src/provider/Services/DiscoveryRegistry";
import { DiscoveryRegistryLive } from "../src/provider/Layers/DiscoveryRegistry";

// ── Test helpers ─────────────────────────────────────────────────────

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
    Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "discovery-integration-" })),
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

const writeAgentFile = (
  fs: FileSystem.FileSystem,
  baseDir: string,
  filename: string,
  content: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const filePath = path.join(baseDir, filename);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, content);
  });

const frontmatter = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSkill body.`;

// ── Integration tests ────────────────────────────────────────────────

describe("DiscoveryRegistry — integration", () => {
  it.layer(NodeServices.layer)(
    "discovers skills across pi, opencode, and cursor providers with correct counts and dedup",
    (it) => {
      it.effect("multi-provider skill discovery", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-integration-" });

          // ── Pi: create 3 skills in the project .pi/skills directory ──
          const piSkillsDir = path.join(cwd, ".pi/skills");
          yield* writeSkillFile(
            fs,
            piSkillsDir,
            "brave-search",
            frontmatter("brave-search", "Brave search skill"),
          );
          yield* writeSkillFile(
            fs,
            piSkillsDir,
            "youtube-transcript",
            frontmatter("youtube-transcript", "YouTube transcript fetcher"),
          );
          yield* writeSkillFile(
            fs,
            piSkillsDir,
            "vscode",
            frontmatter("vscode", "VS Code integration"),
          );

          // ── OpenCode: create 4 skills in project .opencode/skill ──
          const opencodeSkillsDir = path.join(cwd, ".opencode/skill");
          yield* writeSkillFile(
            fs,
            opencodeSkillsDir,
            "brave-search",
            frontmatter("brave-search", "Brave search (opencode)"),
          );
          yield* writeSkillFile(
            fs,
            opencodeSkillsDir,
            "image",
            frontmatter("image", "Image generation"),
          );
          yield* writeSkillFile(
            fs,
            opencodeSkillsDir,
            "social",
            frontmatter("social", "Social media helper"),
          );
          yield* writeSkillFile(fs, opencodeSkillsDir, "ads", frontmatter("ads", "Ads campaigns"));

          // ── Cursor: create 2 skills in project .cursor/skills-cursor ──
          const cursorSkillsDir = path.join(cwd, ".cursor/skills-cursor");
          yield* writeSkillFile(
            fs,
            cursorSkillsDir,
            "canvas",
            frontmatter("canvas", "Canvas tools"),
          );
          yield* writeSkillFile(
            fs,
            cursorSkillsDir,
            "create-skill",
            frontmatter("create-skill", "Skill creation wizard"),
          );

          // ── Agents: project-level markdown agents ──
          const opencodeAgentsDir = path.join(cwd, ".opencode/agents");
          yield* writeAgentFile(
            fs,
            opencodeAgentsDir,
            "my-agent.md",
            "---\nname: my-agent\ndescription: Custom agent\n---\n",
          );
          yield* writeAgentFile(
            fs,
            opencodeAgentsDir,
            "reviewer.md",
            "---\nname: reviewer\ndescription: Code reviewer\n---\n",
          );

          // ── Agents: JSON config agent ──
          const opencodeConfigDir = path.join(cwd, ".opencode");
          yield* fs.makeDirectory(opencodeConfigDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(opencodeConfigDir, "opencode.json"),
            JSON.stringify({
              agent: {
                "json-agent": {
                  description: "Agent from JSON config",
                  mode: "subagent",
                },
              },
            }),
          );

          // ── Scan ──
          const catalog = yield* getCatalog(cwd);
          const skills = catalog.skills as ReadonlyArray<ServerDiscoveredSkill>;
          const agents = catalog.agents as ReadonlyArray<ServerDiscoveredAgent>;

          // ── Assert: total counts ──
          const projectSkills = skills.filter((s) => s.sourcePath?.startsWith(cwd));
          const projectAgents = agents.filter((a) => a.sourcePath?.startsWith(cwd));

          // 9 skills created: 3 pi + 4 opencode + 2 cursor
          // brave-search exists under both pi and opencode, but different providers = no dedup
          assert.isAtLeast(projectSkills.length, 9);

          // Check per-provider counts
          const piSkills = projectSkills.filter((s) => s.provider === "pi");
          const opencodeSkills = projectSkills.filter((s) => s.provider === "opencode");
          const cursorSkills = projectSkills.filter((s) => s.provider === "cursor");

          assert.isAtLeast(piSkills.length, 3);
          assert.isAtLeast(opencodeSkills.length, 4);
          assert.isAtLeast(cursorSkills.length, 2);

          // ── Assert: source attribution ──
          for (const s of projectSkills) {
            assert.strictEqual(s.source, "project");
          }

          // ── Assert: agents ──
          // 2 markdown agents + 1 JSON config agent = 3 project agents
          assert.isAtLeast(projectAgents.length, 3);

          const markdownAgents = projectAgents.filter((a) => a.sourcePath?.endsWith(".md"));
          const jsonAgents = projectAgents.filter((a) => a.sourcePath?.endsWith("opencode.json"));
          assert.isAtLeast(markdownAgents.length, 2);
          assert.isAtLeast(jsonAgents.length, 1);

          const jsonAgent = jsonAgents.find((a) => a.name === "json-agent");
          assert.isDefined(jsonAgent);
          assert.strictEqual(jsonAgent?.description, "Agent from JSON config");

          // ── Assert: sorting ──
          const names = projectSkills.map((s) => s.name);
          const sorted = [...names].toSorted((a, b) => a.localeCompare(b));
          assert.deepEqual(names, sorted);

          const agentNames = projectAgents.map((a) => a.name);
          const sortedAgentNames = [...agentNames].toSorted((a, b) => a.localeCompare(b));
          assert.deepEqual(agentNames, sortedAgentNames);
        }),
      );
    },
  );

  it.layer(NodeServices.layer)(
    "deduplicates skills with same provider and name across paths",
    (it) => {
      it.effect("cross-path dedup", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-integration-" });

          // Create the same skill "dedup-test" in two pi-scanned paths
          const piSkillsDir = path.join(cwd, ".pi/skills");
          const agentsSkillsDir = path.join(cwd, ".agents/skills");
          yield* writeSkillFile(
            fs,
            piSkillsDir,
            "dedup-test",
            frontmatter("dedup-test", "First copy"),
          );
          yield* writeSkillFile(
            fs,
            agentsSkillsDir,
            "dedup-test",
            frontmatter("dedup-test", "Second copy"),
          );

          const catalog = yield* getCatalog(cwd);
          const skills = catalog.skills as ReadonlyArray<ServerDiscoveredSkill>;
          const piDedup = skills.filter(
            (s) => s.provider === "pi" && s.name === "dedup-test" && s.sourcePath?.startsWith(cwd),
          );
          assert.strictEqual(piDedup.length, 1);
        }),
      );
    },
  );

  it.layer(NodeServices.layer)("preserves same-named skills from different providers", (it) => {
    it.effect("cross-provider non-dedup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-integration-" });

        // Same name "shared-skill" under both pi and opencode
        yield* writeSkillFile(
          fs,
          path.join(cwd, ".pi/skills"),
          "shared-skill",
          frontmatter("shared-skill", "Pi version"),
        );
        yield* writeSkillFile(
          fs,
          path.join(cwd, ".opencode/skill"),
          "shared-skill",
          frontmatter("shared-skill", "OpenCode version"),
        );

        const catalog = yield* getCatalog(cwd);
        const skills = catalog.skills as ReadonlyArray<ServerDiscoveredSkill>;
        const matches = skills.filter(
          (s) => s.name === "shared-skill" && s.sourcePath?.startsWith(cwd),
        );
        // Should have 2 entries: one from pi, one from opencode
        assert.strictEqual(matches.length, 2);
        assert.isTrue(matches.some((s) => s.provider === "pi"));
        assert.isTrue(matches.some((s) => s.provider === "opencode"));
      }),
    );
  });

  it.layer(NodeServices.layer)("extracts displayName from H1 heading in skill files", (it) => {
    it.effect("displayName extraction", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-integration-" });

        yield* writeSkillFile(
          fs,
          path.join(cwd, ".pi/skills"),
          "display-test",
          "---\nname: display-test\ndescription: Tests display name\n---\n\n# Display Test Heading\n\nBody.",
        );

        const catalog = yield* getCatalog(cwd);
        const skills = catalog.skills as ReadonlyArray<ServerDiscoveredSkill>;
        const skill = skills.find(
          (s) => s.name === "display-test" && s.sourcePath?.startsWith(cwd),
        );
        assert.isDefined(skill);
        assert.strictEqual(skill?.displayName, "Display Test Heading");
      }),
    );
  });

  it.layer(NodeServices.layer)("JSON config agents handle nested tools objects", (it) => {
    it.effect("nested JSON agent config", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-integration-" });

        yield* fs.makeDirectory(path.join(cwd, ".opencode"), { recursive: true });
        yield* fs.writeFileString(
          path.join(cwd, ".opencode/opencode.json"),
          JSON.stringify({
            agent: {
              "complex-agent": {
                description: "Agent with nested config",
                mode: "subagent",
                tools: { write: true, edit: false, bash: true },
                dependsOn: ["other-agent"],
              },
              "simple-agent": {
                description: "Simple agent",
              },
            },
          }),
        );

        const catalog = yield* getCatalog(cwd);
        const agents = catalog.agents as ReadonlyArray<ServerDiscoveredAgent>;
        const projectAgents = agents.filter(
          (a) => a.source === "project" && a.sourcePath?.startsWith(cwd),
        );
        assert.isAtLeast(projectAgents.length, 2);

        const complex = projectAgents.find((a) => a.name === "complex-agent");
        assert.isDefined(complex);
        assert.strictEqual(complex?.description, "Agent with nested config");

        const simple = projectAgents.find((a) => a.name === "simple-agent");
        assert.isDefined(simple);
        assert.strictEqual(simple?.description, "Simple agent");
      }),
    );
  });

  it.layer(NodeServices.layer)("empty catalog when no discovery directories exist", (it) => {
    it.effect("empty catalog", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-integration-" });

        const catalog = yield* getCatalog(cwd);
        const skills = catalog.skills as ReadonlyArray<ServerDiscoveredSkill>;
        const agents = catalog.agents as ReadonlyArray<ServerDiscoveredAgent>;
        const projectSkills = skills.filter((s) => s.sourcePath?.startsWith(cwd));
        const projectAgents = agents.filter((a) => a.sourcePath?.startsWith(cwd));

        assert.strictEqual(projectSkills.length, 0);
        assert.strictEqual(projectAgents.length, 0);
      }),
    );
  });
});
