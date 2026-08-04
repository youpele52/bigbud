import { describe, expect, it } from "vitest";

import { normalizeProviderModelOptions } from "./normalization.store.models";

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
