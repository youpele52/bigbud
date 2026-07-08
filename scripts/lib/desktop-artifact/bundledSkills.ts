import { Effect, FileSystem, Path } from "effect";

import { BuildScriptError } from "./shared.ts";

export const REQUIRED_BUNDLED_SKILL_NAMES = [
  "automation",
  "git-commit",
  "handoff",
  "teach",
] as const;

export const assertBundledSkillsDirectory = Effect.fn("assertBundledSkillsDirectory")(function* (
  skillsDir: string,
  context: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const missingSkillFiles: string[] = [];
  for (const skillName of REQUIRED_BUNDLED_SKILL_NAMES) {
    const skillPath = path.join(skillsDir, skillName, "SKILL.md");
    if (!(yield* fs.exists(skillPath))) {
      missingSkillFiles.push(`${skillName}/SKILL.md`);
    }
  }

  if (missingSkillFiles.length > 0) {
    return yield* new BuildScriptError({
      message: `${context}: Missing bundled native skills in ${skillsDir}: ${missingSkillFiles.join(", ")}`,
    });
  }
});

export const stageBundledSkills = Effect.fn("stageBundledSkills")(function* (input: {
  readonly repoRoot: string;
  readonly stageServerDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sourceDir = path.join(input.repoRoot, ".bigbud", "skills");
  const targetDir = path.join(input.stageServerDir, "bundled-skills");

  yield* assertBundledSkillsDirectory(
    sourceDir,
    "Desktop artifact build failed before staging bundled skills",
  );
  yield* fs.copy(sourceDir, targetDir);
  yield* assertBundledSkillsDirectory(
    targetDir,
    "Desktop artifact build staged an incomplete bundled skills directory",
  );
});
