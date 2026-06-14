import { describe, expect, it } from "vitest";

import {
  normalizeGitCommitMessageGenerationInput,
  normalizeGitTextGenerationModelSelection,
} from "./RoutingTextGeneration.ts";

describe("normalizeGitTextGenerationModelSelection", () => {
  it("keeps supported codex selections unchanged", () => {
    expect(
      normalizeGitTextGenerationModelSelection({
        provider: "codex",
        model: "gpt-5.4-mini",
        options: { reasoningEffort: "high" },
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
      options: { reasoningEffort: "high" },
    });
  });

  it("maps opencode git text generation to the supported claude provider", () => {
    expect(
      normalizeGitTextGenerationModelSelection({
        provider: "opencode",
        model: "claude-sonnet-4-6",
        options: { reasoningEffort: "medium" },
      }),
    ).toEqual({
      provider: "claudeAgent",
      model: "haiku",
    });
  });

  it("maps kilocode git text generation to the supported claude provider", () => {
    expect(
      normalizeGitTextGenerationModelSelection({
        provider: "kilocode",
        model: "claude-haiku-4-5",
      }),
    ).toEqual({
      provider: "claudeAgent",
      model: "haiku",
    });
  });

  it("maps copilot git text generation to the supported codex provider", () => {
    expect(
      normalizeGitTextGenerationModelSelection({
        provider: "copilot",
        model: "gpt-5-mini",
        options: { reasoningEffort: "high" },
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("maps devin git text generation to the supported codex provider", () => {
    expect(
      normalizeGitTextGenerationModelSelection({
        provider: "devin",
        model: "default",
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("keeps Cursor git text generation on the Cursor provider", () => {
    expect(
      normalizeGitTextGenerationModelSelection({
        provider: "cursor",
        model: "claude-sonnet-4-5",
        options: {
          reasoning: "high",
          fastMode: true,
        },
      }),
    ).toEqual({
      provider: "cursor",
      model: "claude-sonnet-4-5",
      options: {
        reasoning: "high",
        fastMode: true,
      },
    });
  });

  it("preserves commit skill content across routing for every provider selection", () => {
    const cases = [
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        expectedProvider: "codex",
        expectedModel: "gpt-5.4-mini",
      },
      {
        provider: "claudeAgent",
        model: "sonnet",
        expectedProvider: "claudeAgent",
        expectedModel: "sonnet",
      },
      {
        provider: "cursor",
        model: "claude-sonnet-4-5",
        expectedProvider: "cursor",
        expectedModel: "claude-sonnet-4-5",
      },
      {
        provider: "opencode",
        model: "claude-sonnet-4-6",
        expectedProvider: "claudeAgent",
        expectedModel: "haiku",
      },
      {
        provider: "kilocode",
        model: "claude-haiku-4-5",
        expectedProvider: "claudeAgent",
        expectedModel: "haiku",
      },
      {
        provider: "pi",
        model: "pi-default",
        expectedProvider: "claudeAgent",
        expectedModel: "haiku",
      },
      {
        provider: "copilot",
        model: "gpt-5-mini",
        expectedProvider: "codex",
        expectedModel: "gpt-5.4-mini",
      },
      {
        provider: "devin",
        model: "default",
        expectedProvider: "codex",
        expectedModel: "gpt-5.4-mini",
      },
    ] as const;

    for (const testCase of cases) {
      const result = normalizeGitCommitMessageGenerationInput({
        cwd: "/repo",
        branch: "main",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        skillContent: "# Git Commit\n\nUse past tense.",
        modelSelection: {
          provider: testCase.provider,
          model: testCase.model,
        },
      });

      expect(result.skillContent).toBe("# Git Commit\n\nUse past tense.");
      expect(result.cwd).toBe("/repo");
      expect(result.branch).toBe("main");
      expect(result.modelSelection).toEqual({
        provider: testCase.expectedProvider,
        model: testCase.expectedModel,
      });
    }
  });
});
