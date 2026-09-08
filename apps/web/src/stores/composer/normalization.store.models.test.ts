import { describe, expect, it } from "vitest";

import { normalizeProviderModelOptions } from "./normalization.store.models";

describe("normalizeProviderModelOptions Codex effort", () => {
  it("preserves trimmed dynamic effort values", () => {
    expect(
      normalizeProviderModelOptions({ codex: { reasoningEffort: "  future-depth  " } }, "codex"),
    ).toMatchObject({ codex: { reasoningEffort: "future-depth" } });
    expect(
      normalizeProviderModelOptions(undefined, "codex", { effort: "  legacy-depth  " }),
    ).toMatchObject({ codex: { reasoningEffort: "legacy-depth" } });
  });

  it("drops blank effort values", () => {
    expect(
      normalizeProviderModelOptions({ codex: { reasoningEffort: "   " } }, "codex"),
    ).toBeNull();
  });
});

describe("normalizeProviderModelOptions Claude effort", () => {
  it("preserves trimmed future and legacy prompt-injected effort values", () => {
    expect(
      normalizeProviderModelOptions({ claudeAgent: { effort: "  future-depth  " } }, "claudeAgent"),
    ).toMatchObject({ claudeAgent: { effort: "future-depth" } });
    expect(
      normalizeProviderModelOptions({ claudeAgent: { effort: "ultrathink" } }, "claudeAgent"),
    ).toMatchObject({ claudeAgent: { effort: "ultrathink" } });
  });

  it("drops blank Claude effort values", () => {
    expect(
      normalizeProviderModelOptions({ claudeAgent: { effort: "   " } }, "claudeAgent"),
    ).toBeNull();
  });
});
