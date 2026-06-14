import { homedir } from "node:os";
import { join } from "node:path";
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

  it("returns null when the skill file does not exist", async () => {
    const content = await runWithFs(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return yield* loadSkillPrompt({ skillName: "missing", fileSystem });
      }),
    );

    expect(content).toBeNull();
  });
});
