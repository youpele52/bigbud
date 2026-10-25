import type { ServerDiscoveredSkill } from "@bigbud/contracts/server/server.providers.ts";
import { describe, expect, it } from "vitest";
import {
  buildReferencedSourcePathLookup,
  resolveMentionSourcePath,
} from "./MessagesTimeline.userMessage.sources";

function skill(
  provider: ServerDiscoveredSkill["provider"],
  sourcePath?: string,
): ServerDiscoveredSkill {
  return {
    id: provider,
    name: "review",
    source: "user",
    provider,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

function resolve(overrides: Partial<Parameters<typeof resolveMentionSourcePath>[0]> = {}) {
  return resolveMentionSourcePath({
    kind: "skill",
    name: "review",
    references: new Map(),
    agents: [],
    skills: [],
    preferredProvider: "opencode",
    ...overrides,
  });
}

describe("sent-message source resolution", () => {
  it("reproduces same-name paths and resolves using invocation provider precedence", () => {
    const skills = [
      skill("codex", "/codex/review/SKILL.md"),
      skill("opencode", "/opencode/review/SKILL.md"),
    ];
    // The previous renderer disabled this chip because these paths were not unique.
    expect(new Set(skills.map((entry) => entry.sourcePath)).size).toBe(2);
    expect(resolve({ skills })).toBe("/opencode/review/SKILL.md");
  });

  it("uses recorded provenance before current discovery, even after changing providers", () => {
    const references = buildReferencedSourcePathLookup(
      "Referenced skill: review\nProvider: codex\nSource path: /old/SKILL.md",
    );
    expect(resolve({ references, skills: [skill("opencode", "/new/SKILL.md")] })).toBe(
      "/old/SKILL.md",
    );
  });

  it("resolves multiple recorded providers when the thread provider supplies a trustworthy match", () => {
    const references = buildReferencedSourcePathLookup(
      [
        "Referenced agent: review",
        "Provider: codex",
        "Source path: /codex/review.toml",
        "Referenced agent: review",
        "Provider: opencode",
        "Source path: /opencode/review.md",
      ].join("\n"),
    );
    expect(resolve({ kind: "agent", references })).toBe("/opencode/review.md");
    expect(resolve({ kind: "agent", references, preferredProvider: "claudeAgent" })).toBeNull();
  });

  it("keeps genuine ambiguity non-clickable rather than guessing", () => {
    expect(
      resolve({ skills: [skill("codex", "/a.md"), skill("claudeAgent", "/b.md")] }),
    ).toBeNull();
  });

  it("allows a common source shared across providers", () => {
    expect(
      resolve({
        skills: [skill("codex", "/shared/SKILL.md"), skill("claudeAgent", "/shared/SKILL.md")],
      }),
    ).toBe("/shared/SKILL.md");
  });

  it("does not substitute another provider's path when the selected entry has none", () => {
    expect(resolve({ skills: [skill("opencode"), skill("codex", "/wrong.md")] })).toBeNull();
  });

  it("resolves skill display-name aliases without overriding canonical-name matches", () => {
    const alias = { ...skill("opencode", "/alias.md"), name: "other", displayName: "Review" };
    expect(resolve({ skills: [alias] })).toBe("/alias.md");
    expect(resolve({ skills: [alias, skill("opencode", "/canonical.md")] })).toBe("/canonical.md");
  });
});
