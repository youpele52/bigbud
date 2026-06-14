import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { getCatalog, writeFile } from "./DiscoveryRegistry.test.shared";

// ── .bigbud/skills discovery ─────────────────────────────────────────

describe("DiscoveryRegistry — .bigbud/skills discovery", () => {
  it.layer(NodeServices.layer)(
    "labels skills from .bigbud/skills with the bigbud provider",
    (it) => {
      it.effect("discovers SKILL.md under the project .bigbud/skills directory", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-bigbud-" });

          yield* writeFile(
            path.join(cwd, ".bigbud/skills/git-commit/SKILL.md"),
            [
              "---",
              "name: git-commit",
              "description: Create well-formatted git commits",
              "---",
              "",
              "# Git Commit",
              "",
              "Body.",
            ].join("\n"),
          );

          const catalog = yield* getCatalog(cwd);
          const skill = catalog.skills.find(
            (s) => s.sourcePath?.startsWith(cwd) && s.name === "git-commit",
          );

          assert.isDefined(skill, "skill should be discovered under .bigbud/skills");
          assert.strictEqual(skill?.provider, "bigbud");
          assert.strictEqual(skill?.source, "project");
          assert.strictEqual(skill?.displayName, "Git Commit");
          assert.strictEqual(skill?.description, "Create well-formatted git commits");
        }),
      );

      it.effect("falls back to folder name when SKILL.md has no frontmatter", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-bigbud-" });

          yield* writeFile(
            path.join(cwd, ".bigbud/skills/handoff/SKILL.md"),
            "Plain skill body without frontmatter.",
          );

          const catalog = yield* getCatalog(cwd);
          const skill = catalog.skills.find(
            (s) => s.sourcePath?.startsWith(cwd) && s.name === "handoff",
          );

          assert.isDefined(skill, "skill should be discovered from folder name");
          assert.strictEqual(skill?.provider, "bigbud");
          assert.strictEqual(skill?.source, "project");
        }),
      );

      it.effect("does NOT pick up .bigbud/skills node_modules SKILL.md", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-bigbud-" });

          yield* writeFile(
            path.join(cwd, ".bigbud/skills/my-skill/node_modules/some-pkg/SKILL.md"),
            "---\nname: Injected\n---\n",
          );
          yield* writeFile(
            path.join(cwd, ".bigbud/skills/my-skill/SKILL.md"),
            "---\nname: Real\n---\n",
          );

          const catalog = yield* getCatalog(cwd);
          const cwdSkills = catalog.skills.filter(
            (s) => s.sourcePath?.startsWith(cwd) && s.provider === "bigbud",
          );

          assert.isUndefined(
            cwdSkills.find((s) => s.name === "Injected"),
            "node_modules SKILL.md must not be discovered",
          );
          assert.isDefined(
            cwdSkills.find((s) => s.name === "Real"),
            "legitimate SKILL.md should still be discovered",
          );
        }),
      );
    },
  );
});
