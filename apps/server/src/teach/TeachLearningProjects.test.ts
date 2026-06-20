import { describe, expect, it } from "vitest";

import {
  extractTeachTopicFromMessage,
  getTeachProjectFolderForPath,
  readMissionTitle,
  resolveTeachLearningRoot,
  resolveTeachProjectPath,
  slugifyTeachTopic,
} from "./TeachLearningProjects.utils.ts";

describe("TeachLearningProjects.utils", () => {
  it("resolves learning paths from the default chat folder", () => {
    expect(resolveTeachLearningRoot("/Users/test/Documents")).toBe(
      "/Users/test/Documents/bigbud-learn",
    );
    expect(resolveTeachProjectPath("/Users/test/Documents", "personal-budgeting")).toBe(
      "/Users/test/Documents/bigbud-learn/personal-budgeting",
    );
  });

  it("slugifies teach topics", () => {
    expect(slugifyTeachTopic("Personal Budgeting!")).toBe("personal-budgeting");
    expect(slugifyTeachTopic("   ")).toBe("learning-project");
  });

  it("extracts teach topics from slash commands", () => {
    expect(extractTeachTopicFromMessage("/skills teach budgeting")).toBe("budgeting");
    expect(extractTeachTopicFromMessage("/skill teach photography basics")).toBe(
      "photography basics",
    );
    expect(extractTeachTopicFromMessage("/skills handoff")).toBeUndefined();
  });

  it("reads mission titles from MISSION.md headings", () => {
    expect(readMissionTitle("# Mission: Personal Budgeting\n\n## Why\nSave money.")).toBe(
      "Personal Budgeting",
    );
  });

  it("detects whether a path is inside a teach project folder", () => {
    const learningRoot = "/Users/test/Documents/bigbud-learn";
    expect(
      getTeachProjectFolderForPath(
        learningRoot,
        "/Users/test/Documents/bigbud-learn/personal-budgeting/MISSION.md",
      ),
    ).toBe("/Users/test/Documents/bigbud-learn/personal-budgeting");
    expect(getTeachProjectFolderForPath(learningRoot, "/Users/test/Documents/MISSION.md")).toBe(
      undefined,
    );
    expect(getTeachProjectFolderForPath(learningRoot, learningRoot)).toBeUndefined();
  });
});
