import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  assertBundledSkillsDirectory,
  REQUIRED_BUNDLED_SKILL_NAMES,
  stageBundledSkills,
} from "./bundledSkills.ts";

const writeFile = Effect.fn("writeFile")(function* (filePath: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, content);
});

describe("bundledSkills", () => {
  it.layer(NodeServices.layer)("validates and stages the packaged native skills", (it) => {
    it.effect("accepts a complete bundled skills directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const skillsDir = yield* fs.makeTempDirectoryScoped({ prefix: "bundled-skills-" });

        for (const skillName of REQUIRED_BUNDLED_SKILL_NAMES) {
          yield* writeFile(path.join(skillsDir, skillName, "SKILL.md"), `# ${skillName}`);
        }

        yield* assertBundledSkillsDirectory(skillsDir, "test");
      }),
    );

    it.effect("fails when a required native skill is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const skillsDir = yield* fs.makeTempDirectoryScoped({ prefix: "bundled-skills-" });

        for (const skillName of REQUIRED_BUNDLED_SKILL_NAMES.filter((name) => name !== "teach")) {
          yield* writeFile(path.join(skillsDir, skillName, "SKILL.md"), `# ${skillName}`);
        }

        const error = yield* Effect.flip(assertBundledSkillsDirectory(skillsDir, "test"));
        assert.equal(error._tag, "BuildScriptError");
        assert.ok(error.message.includes("teach/SKILL.md"));
      }),
    );

    it.effect("copies repo native skills into the staged server runtime", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "bundled-skills-repo-" });
        const stageServerDir = yield* fs.makeTempDirectoryScoped({
          prefix: "bundled-skills-stage-server-",
        });

        for (const skillName of REQUIRED_BUNDLED_SKILL_NAMES) {
          yield* writeFile(
            path.join(repoRoot, ".bigbud", "skills", skillName, "SKILL.md"),
            `# ${skillName}`,
          );
        }

        yield* stageBundledSkills({ repoRoot, stageServerDir });

        for (const skillName of REQUIRED_BUNDLED_SKILL_NAMES) {
          const skillPath = path.join(stageServerDir, "bundled-skills", skillName, "SKILL.md");
          assert.isTrue(yield* fs.exists(skillPath));
        }
      }),
    );
  });
});
