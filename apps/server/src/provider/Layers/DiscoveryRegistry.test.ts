/**
 * Tests for DiscoveryRegistry — skill/agent discovery, path filtering,
 * node_modules exclusion, and catalog merging.
 *
 * Strategy: use NodeServices (real filesystem via temp dirs) to exercise
 * DiscoveryRegistryLive end-to-end. Pure helpers (inferNameFromPath etc.) are
 * indirectly exercised through the catalog output.
 *
 * Important: descriptors include both project-scoped paths (under `cwd`) and
 * user-scoped paths (under OS.homedir()). Tests that need isolation must filter
 * results by `sourcePath` to only inspect entries discovered from the temp cwd.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";

import { ServerConfig } from "../../startup/config";
import { ServerSettingsService } from "../../ws/serverSettings";
import { DiscoveryRegistry } from "../Services/DiscoveryRegistry";
import { DiscoveryRegistryLive, haveDiscoveryChanged } from "./DiscoveryRegistry";

// ── Test layer helpers ───────────────────────────────────────────────

/** Stub ServerSettingsService that returns default settings and never streams. */
const makeStubSettingsLayer = () =>
  Layer.succeed(ServerSettingsService, {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
    streamChanges: Stream.empty,
  });

/**
 * Build a DiscoveryRegistryLive layer with a given temp directory as cwd.
 */
const makeRegistryLayer = (cwd: string) =>
  DiscoveryRegistryLive.pipe(
    Layer.provideMerge(makeStubSettingsLayer()),
    Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "discovery-registry-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

/**
 * Get the catalog from the registry.
 */
const getCatalog = (cwd: string) =>
  Effect.gen(function* () {
    const registry = yield* DiscoveryRegistry;
    return yield* registry.getCatalog;
  }).pipe(Effect.provide(makeRegistryLayer(cwd)));

/**
 * Write a file at `filePath`, creating all parent directories first.
 */
const writeFile = (filePath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, content);
  });

// ── haveDiscoveryChanged ─────────────────────────────────────────────

it.layer(NodeServices.layer)("haveDiscoveryChanged", (it) => {
  it.effect("returns false when catalogs are structurally equal", () =>
    Effect.sync(() => {
      const catalog = { agents: [], skills: [] };
      assert.isFalse(haveDiscoveryChanged(catalog, { agents: [], skills: [] }));
    }),
  );

  it.effect("returns true when skills differ", () =>
    Effect.sync(() => {
      const a = { agents: [], skills: [] };
      const b = {
        agents: [],
        skills: [
          {
            id: "pi:skill:brave-search",
            provider: "pi" as const,
            name: "brave-search",
            source: "user" as const,
            sourcePath: "/some/path/SKILL.md",
          },
        ],
      };
      assert.isTrue(haveDiscoveryChanged(a, b));
    }),
  );

  it.effect("returns true when agents differ", () =>
    Effect.sync(() => {
      const a = { agents: [], skills: [] };
      const b = {
        agents: [
          {
            id: "codex:agent:my-agent",
            provider: "codex" as const,
            name: "my-agent",
            source: "project" as const,
            sourcePath: "/some/path/agent.md",
          },
        ],
        skills: [],
      };
      assert.isTrue(haveDiscoveryChanged(a, b));
    }),
  );
});

// ── Skill discovery ──────────────────────────────────────────────────

describe("DiscoveryRegistry — skill discovery", () => {
  it.layer(NodeServices.layer)("picks up SKILL.md files from .pi/skills", (it) => {
    it.effect("discovers skill with frontmatter name and description", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        yield* writeFile(
          path.join(cwd, ".pi/skills/my-skill/SKILL.md"),
          "---\nname: My Skill\ndescription: Does something useful\n---\n\nContent here.",
        );

        const catalog = yield* getCatalog(cwd);

        // Filter to project-scoped entries sourced from our temp cwd
        const skill = catalog.skills.find(
          (s) => s.sourcePath?.startsWith(cwd) && s.name === "My Skill",
        );
        assert.isDefined(skill, "skill should be discovered");
        assert.strictEqual(skill?.description, "Does something useful");
        assert.strictEqual(skill?.provider, "pi");
        assert.strictEqual(skill?.source, "project");
      }),
    );

    it.effect("falls back to parent directory name when SKILL.md has no frontmatter", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        yield* writeFile(
          path.join(cwd, ".pi/skills/brave-search/SKILL.md"),
          "A skill without frontmatter.",
        );

        const catalog = yield* getCatalog(cwd);

        const skill = catalog.skills.find(
          (s) => s.sourcePath?.startsWith(cwd) && s.name === "brave-search",
        );
        assert.isDefined(skill, "should fall back to parent directory name");
      }),
    );

    it.effect("uses H1 heading as name when no frontmatter is present", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        yield* writeFile(
          path.join(cwd, ".pi/skills/heading-skill/SKILL.md"),
          "# Heading Skill Name\n\nSome description here.",
        );

        const catalog = yield* getCatalog(cwd);

        const skill = catalog.skills.find(
          (s) => s.sourcePath?.startsWith(cwd) && s.name === "Heading Skill Name",
        );
        assert.isDefined(skill, "should use H1 heading as name");
      }),
    );

    it.effect("does NOT pick up plain README.md as a skill", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        yield* writeFile(
          path.join(cwd, ".pi/skills/README.md"),
          "# Skills\n\nThis directory contains pi skills.",
        );

        const catalog = yield* getCatalog(cwd);

        const readmeSkill = catalog.skills.find(
          (s) => s.sourcePath?.startsWith(cwd) && s.name === "README",
        );
        assert.isUndefined(readmeSkill, "README.md must not be treated as a skill");
      }),
    );

    it.effect("does NOT pick up SKILL.md files inside node_modules", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        // Nested node_modules SKILL.md — must be excluded
        yield* writeFile(
          path.join(cwd, ".pi/skills/my-skill/node_modules/some-pkg/SKILL.md"),
          "---\nname: Injected Package\n---\n",
        );
        // The real skill at the correct location should still be found
        yield* writeFile(
          path.join(cwd, ".pi/skills/my-skill/SKILL.md"),
          "---\nname: Real Skill\n---\n",
        );

        const catalog = yield* getCatalog(cwd);
        const cwdSkills = catalog.skills.filter((s) => s.sourcePath?.startsWith(cwd));

        assert.isUndefined(
          cwdSkills.find((s) => s.name === "Injected Package"),
          "node_modules SKILL.md must not be discovered",
        );
        assert.isDefined(
          cwdSkills.find((s) => s.name === "Real Skill"),
          "legitimate SKILL.md should still be found",
        );
      }),
    );

    it.effect("does NOT pick up README/CHANGELOG inside node_modules subtree", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        const nodeModulesBase = path.join(cwd, ".pi/skills/pi-skills/node_modules");

        for (const pkg of ["@babel/code-frame", "ansi-styles", "balanced-match"]) {
          yield* writeFile(
            path.join(nodeModulesBase, pkg, "README.md"),
            `# ${pkg}\n\nSome npm package readme.`,
          );
          yield* writeFile(
            path.join(nodeModulesBase, pkg, "CHANGELOG.md"),
            `# Changelog\n\n## v1.0.0`,
          );
        }

        const catalog = yield* getCatalog(cwd);
        const cwdSkills = catalog.skills.filter((s) => s.sourcePath?.startsWith(cwd));

        assert.strictEqual(
          cwdSkills.length,
          0,
          "no npm package docs should appear as skills from this cwd",
        );
      }),
    );

    it.effect("discovers multiple skills across subdirectories", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        for (const name of ["brave-search", "youtube-transcript", "vscode"]) {
          yield* writeFile(
            path.join(cwd, `.pi/skills/${name}/SKILL.md`),
            `---\nname: ${name}\ndescription: Skill for ${name}\n---\n`,
          );
        }

        const catalog = yield* getCatalog(cwd);
        const cwdPiSkills = catalog.skills.filter(
          (s) => s.provider === "pi" && s.sourcePath?.startsWith(cwd),
        );

        assert.isAtLeast(cwdPiSkills.length, 3);
        for (const name of ["brave-search", "youtube-transcript", "vscode"]) {
          assert.isDefined(
            cwdPiSkills.find((s) => s.name === name),
            `should find skill: ${name}`,
          );
        }
      }),
    );

    it.effect("deduplicates skills with the same provider and name", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        // Create the same skill name in two different project-scoped pi paths
        yield* writeFile(
          path.join(cwd, ".pi/skills/brave-search/SKILL.md"),
          "---\nname: brave-search\n---\n",
        );
        yield* writeFile(
          path.join(cwd, ".agents/skills/brave-search/SKILL.md"),
          "---\nname: brave-search\n---\n",
        );

        const catalog = yield* getCatalog(cwd);

        // After dedup, at most one entry per name+provider key
        const matches = catalog.skills.filter(
          (s) => s.provider === "pi" && s.name === "brave-search",
        );
        assert.isAtMost(matches.length, 1, "duplicate skill entries should be merged");
      }),
    );

    it.effect("returns no project-scoped pi skills when directory does not exist", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        // No .pi/skills directory created — only check cwd-scoped results
        const catalog = yield* getCatalog(cwd);
        const cwdPiSkills = catalog.skills.filter(
          (s) => s.provider === "pi" && s.sourcePath?.startsWith(cwd),
        );
        assert.strictEqual(cwdPiSkills.length, 0);
      }),
    );
  });
});

// ── Agent discovery ──────────────────────────────────────────────────

describe("DiscoveryRegistry — agent discovery", () => {
  it.layer(NodeServices.layer)("picks up agent files from project directories", (it) => {
    it.effect("discovers a codex agent from .codex/agents/ using TOML name field", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        // Codex agents are always parsed via parseCodexTomlAgent regardless
        // of file extension — the content must use TOML `name = "..."` syntax.
        yield* writeFile(
          path.join(cwd, ".codex/agents/my-agent.md"),
          `name = "My Agent"\ndescription = "Helpful agent"\n`,
        );

        const catalog = yield* getCatalog(cwd);

        const agent = catalog.agents.find(
          (a) => a.sourcePath?.startsWith(cwd) && a.name === "My Agent",
        );
        assert.isDefined(agent, "should discover agent from .codex/agents/");
        assert.strictEqual(agent?.provider, "codex");
        assert.strictEqual(agent?.source, "project");
      }),
    );

    it.effect("discovers a codex agent from TOML format", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        yield* writeFile(
          path.join(cwd, ".codex/agents/my-toml-agent.toml"),
          `name = "TOML Agent"\ndescription = "A toml-defined agent"\n`,
        );

        const catalog = yield* getCatalog(cwd);

        const agent = catalog.agents.find(
          (a) => a.sourcePath?.startsWith(cwd) && a.name === "TOML Agent",
        );
        assert.isDefined(agent, "should discover codex agent from .toml file");
        assert.strictEqual(agent?.description, "A toml-defined agent");
      }),
    );

    it.effect("does NOT pick up agent files inside node_modules", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        yield* writeFile(
          path.join(cwd, ".codex/agents/node_modules/some-dep/agent.md"),
          "---\nname: some-dep\n---\n",
        );

        const catalog = yield* getCatalog(cwd);
        const cwdAgents = catalog.agents.filter((a) => a.sourcePath?.startsWith(cwd));

        assert.isUndefined(
          cwdAgents.find((a) => a.name === "some-dep"),
          "node_modules agent files must be excluded",
        );
      }),
    );

    it.effect("returns no project-scoped codex agents when directory does not exist", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        const catalog = yield* getCatalog(cwd);
        const cwdCodexAgents = catalog.agents.filter(
          (a) => a.provider === "codex" && a.sourcePath?.startsWith(cwd),
        );
        assert.strictEqual(cwdCodexAgents.length, 0);
      }),
    );
  });
});

// ── Opencode config agent parsing ────────────────────────────────────

describe("DiscoveryRegistry — opencode config agents", () => {
  it.layer(NodeServices.layer)("parses opencode config JSON agent blocks", (it) => {
    it.effect("discovers agents defined in .opencode/opencode.json", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        // The config descriptor scans .opencode/opencode.json for
        // `agent = { name = "..." description = "..." }` TOML-style blocks
        yield* writeFile(
          path.join(cwd, ".opencode/opencode.json"),
          `agent = {\n  name = "My Reviewer"\n  description = "Reviews code"\n}\n`,
        );

        const catalog = yield* getCatalog(cwd);

        const agent = catalog.agents.find(
          (a) => a.provider === "opencode" && a.name === "My Reviewer",
        );
        assert.isDefined(agent, "should discover opencode config agent");
        assert.strictEqual(agent?.description, "Reviews code");
        assert.strictEqual(agent?.source, "project");
      }),
    );

    it.effect("returns no project-scoped opencode agents when config does not exist", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        const catalog = yield* getCatalog(cwd);

        // Only check project-scoped entries (source === "project") to avoid
        // the user's real ~/.config/opencode/opencode.json affecting results
        const projectOpencode = catalog.agents.filter(
          (a) => a.provider === "opencode" && a.source === "project",
        );
        assert.strictEqual(projectOpencode.length, 0);
      }),
    );
  });
});

// ── Catalog sorting ──────────────────────────────────────────────────

describe("DiscoveryRegistry — catalog sorting", () => {
  it.layer(NodeServices.layer)(
    "skills and agents are returned sorted alphabetically by name",
    (it) => {
      it.effect("project-scoped pi skills from cwd are sorted alphabetically by name", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

          for (const name of ["zebra-tool", "alpha-tool", "middle-tool"]) {
            yield* writeFile(
              path.join(cwd, `.pi/skills/${name}/SKILL.md`),
              `---\nname: ${name}\n---\n`,
            );
          }

          const catalog = yield* getCatalog(cwd);

          // Extract only the names from project-scoped pi skills in this temp dir
          const cwdPiSkillNames = catalog.skills
            .filter((s) => s.provider === "pi" && s.sourcePath?.startsWith(cwd))
            .map((s) => s.name);

          assert.isAtLeast(cwdPiSkillNames.length, 3, "should find all 3 skills");

          // The full catalog is sorted — verify our subset appears in order too
          const sorted = [...cwdPiSkillNames].toSorted((a, b) => a.localeCompare(b));
          assert.deepEqual(cwdPiSkillNames, sorted, "skills should be sorted alphabetically");
        }),
      );
    },
  );
});
