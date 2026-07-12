import { describe, expect, it } from "vitest";

import { applyValidatedSkillPatch, validateMemoryReplacement } from "./LearningValidation.ts";

describe("validateMemoryReplacement", () => {
  it("rejects secrets and destructive replacement of established memory", () => {
    expect(validateMemoryReplacement("", "api_key=secret-value\n")).toBe(false);
    expect(validateMemoryReplacement("a".repeat(500), "short\n")).toBe(false);
  });

  it("accepts a concise nonsensitive update", () => {
    expect(validateMemoryReplacement("# Memory\n", "# Memory\n- Prefer concise replies.\n")).toBe(
      true,
    );
  });
});

describe("applyValidatedSkillPatch", () => {
  const skill = [
    "---",
    "description: Keep code consistent",
    "---",
    "",
    "# Workflow",
    "",
    "Inspect nearby code before editing.",
    "",
  ].join("\n");

  it("applies one targeted content patch", () => {
    expect(
      applyValidatedSkillPatch({
        current: skill,
        oldText: "Inspect nearby code before editing.",
        newText: "Inspect nearby code and tests before editing.",
      }),
    ).toContain("Inspect nearby code and tests before editing.");
  });

  it("rejects whole-file, frontmatter, heading, and ambiguous patches", () => {
    expect(
      applyValidatedSkillPatch({ current: skill, oldText: skill, newText: "replacement" }),
    ).toBeNull();
    expect(
      applyValidatedSkillPatch({
        current: skill,
        oldText: "description: Keep code consistent",
        newText: "description: Behave differently",
      }),
    ).toBeNull();
    expect(
      applyValidatedSkillPatch({ current: skill, oldText: "# Workflow", newText: "# Changed" }),
    ).toBeNull();
    expect(
      applyValidatedSkillPatch({
        current: "repeat\nrepeat\n",
        oldText: "repeat",
        newText: "changed",
      }),
    ).toBeNull();
  });
});
