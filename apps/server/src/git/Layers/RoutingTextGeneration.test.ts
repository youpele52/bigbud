import { describe, expect, it } from "vitest";

import { normalizeGitTextGenerationModelSelection } from "./RoutingTextGeneration.ts";

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
      model: "claude-haiku-4-5",
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
});
