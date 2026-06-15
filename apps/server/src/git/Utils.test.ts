import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";

import { loadSkillPrompt, skillPromptPaths, stripSkillFrontmatter } from "./Utils.ts";

const runWithFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

describe("stripSkillFrontmatter", () => {
  it("removes yaml frontmatter from a skill file", () => {
    const content = "---\nname: git-commit\ndescription: Test\n---\n\n# Body\n\nInstructions.";
    expect(stripSkillFrontmatter(content)).toBe("# Body\n\nInstructions.");
  });

  it("returns the full content when there is no frontmatter", () => {
    const content = "# Body\n\nInstructions.";
    expect(stripSkillFrontmatter(content)).toBe("# Body\n\nInstructions.");
  });
});

describe("loadSkillPrompt", () => {
  it("looks for bundled skills under ~/.bigbud/skills", () => {
    expect(skillPromptPaths("git-commit")).toEqual([
      join(homedir(), ".bigbud/skills", "git-commit", "SKILL.md"),
    ]);
  });

  it("prefers packaged bundled skills when BIGBUD_BUNDLED_SKILLS_DIR is set", () => {
    const previousBundledSkillsDir = process.env.BIGBUD_BUNDLED_SKILLS_DIR;
    try {
      process.env.BIGBUD_BUNDLED_SKILLS_DIR = "/opt/bigbud/resources/server/bundled-skills";

      expect(skillPromptPaths("git-commit")).toEqual([
        "/opt/bigbud/resources/server/bundled-skills/git-commit/SKILL.md",
        join(homedir(), ".bigbud/skills", "git-commit", "SKILL.md"),
      ]);
    } finally {
      if (previousBundledSkillsDir === undefined) {
        delete process.env.BIGBUD_BUNDLED_SKILLS_DIR;
      } else {
        process.env.BIGBUD_BUNDLED_SKILLS_DIR = previousBundledSkillsDir;
      }
    }
  });

  it("returns null when the skill file does not exist", async () => {
    const content = await runWithFs(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return yield* loadSkillPrompt({ skillName: "missing", fileSystem });
      }),
    );

    expect(content).toBeNull();
  });

  it("loads skill content from the packaged bundled skills directory", async () => {
    const previousBundledSkillsDir = process.env.BIGBUD_BUNDLED_SKILLS_DIR;
    try {
      const content = await runWithFs(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const skillsDir = yield* fileSystem.makeTempDirectory({
            prefix: "bigbud-git-skill-",
          });
          try {
            process.env.BIGBUD_BUNDLED_SKILLS_DIR = skillsDir;
            const skillPath = join(skillsDir, "git-commit", "SKILL.md");
            yield* fileSystem.makeDirectory(dirname(skillPath), { recursive: true });
            yield* fileSystem.writeFileString(
              skillPath,
              "---\nname: git-commit\n---\n\n# Git Commit\n\nUse past tense.",
            );

            return yield* loadSkillPrompt({ skillName: "git-commit", fileSystem });
          } finally {
            yield* fileSystem.remove(skillsDir, { recursive: true });
          }
        }),
      );

      expect(content).toBe("# Git Commit\n\nUse past tense.");
    } finally {
      if (previousBundledSkillsDir === undefined) {
        delete process.env.BIGBUD_BUNDLED_SKILLS_DIR;
      } else {
        process.env.BIGBUD_BUNDLED_SKILLS_DIR = previousBundledSkillsDir;
      }
    }
  });
});
