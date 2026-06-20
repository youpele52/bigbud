import fs from "node:fs";
import os from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { listTeachLearningProjects } from "./TeachLearningProjects.ts";

describe("TeachLearningProjects", () => {
  it("ensures bigbud-learn exists and lists mission-backed projects", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-teach-list-"));
    const defaultChatCwd = path.join(baseDir, "Documents");
    const projectDir = path.join(defaultChatCwd, "bigbud-learn", "personal-budgeting");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "MISSION.md"),
      "# Mission: Personal Budgeting\n",
      "utf8",
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return yield* listTeachLearningProjects({
          fileSystem,
          defaultChatCwd,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.defaultChatCwd).toBe(defaultChatCwd);
    expect(result.learningRootPath).toBe(path.join(defaultChatCwd, "bigbud-learn"));
    expect(fs.existsSync(result.learningRootPath)).toBe(true);
    expect(result.projects).toEqual([
      expect.objectContaining({
        slug: "personal-budgeting",
        absolutePath: projectDir,
        title: "Personal Budgeting",
      }),
    ]);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("reports misplaced teaching artifacts at the default chat folder root", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-teach-misplaced-"));
    const defaultChatCwd = path.join(baseDir, "Documents");
    fs.mkdirSync(defaultChatCwd, { recursive: true });
    fs.writeFileSync(path.join(defaultChatCwd, "MISSION.md"), "# Mission: Wrong place\n", "utf8");
    fs.writeFileSync(path.join(defaultChatCwd, "NOTES.md"), "notes\n", "utf8");

    const { buildTeachSkillRuntimeContext } = await import("./TeachLearningProjects.ts");
    const context = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return yield* buildTeachSkillRuntimeContext({
          fileSystem,
          defaultChatCwd,
          messageText: "/skills teach budgeting",
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(context).toContain("Misplaced teaching files detected");
    expect(context).toContain(path.join(defaultChatCwd, "MISSION.md"));
    expect(context).toContain(path.join(defaultChatCwd, "NOTES.md"));

    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});
