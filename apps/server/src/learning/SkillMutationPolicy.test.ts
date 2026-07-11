import { describe, expect, it } from "vitest";

import { mayApplySkillMutation, resolveSkillMutationPolicy } from "./SkillMutationPolicy.ts";

describe("SkillMutationPolicy", () => {
  it("forbids changes to bigbud-native skills even with approval", () => {
    const policy = resolveSkillMutationPolicy({ provider: "bigbud", source: "user" });
    expect(policy).toBe("forbidden");
    expect(mayApplySkillMutation({ policy, explicitlyApproved: true })).toBe(false);
  });

  it("requires explicit approval for user-owned provider skills", () => {
    const policy = resolveSkillMutationPolicy({ provider: "codex", source: "user" });
    expect(policy).toBe("approval-required");
    expect(mayApplySkillMutation({ policy, explicitlyApproved: false })).toBe(false);
    expect(mayApplySkillMutation({ policy, explicitlyApproved: true })).toBe(true);
  });

  it("forbids changes to plugin and system skills", () => {
    expect(resolveSkillMutationPolicy({ provider: "opencode", source: "plugin" })).toBe(
      "forbidden",
    );
    expect(resolveSkillMutationPolicy({ provider: "claudeAgent", source: "system" })).toBe(
      "forbidden",
    );
  });
});
