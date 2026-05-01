import { describe, expect, it } from "vitest";
import { visibleModelOptionsForPicker } from "./ProviderModelPicker";

describe("visibleModelOptionsForPicker", () => {
  const options = [
    { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  ] as const;

  it("hides duplicate recent models for providers without sub-providers", () => {
    const result = visibleModelOptionsForPicker("codex", options, [options[0]], "");
    expect(result.map((option) => option.slug)).toEqual(["gpt-5.4", "gpt-5.3-codex"]);
  });

  it("keeps duplicate recent models visible while searching", () => {
    const result = visibleModelOptionsForPicker("codex", options, [options[0]], "mini");
    expect(result.map((option) => option.slug)).toEqual([
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.3-codex",
    ]);
  });

  it("keeps sub-provider-backed recent models in the main list for opencode", () => {
    const opencodeOptions = [
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", subProviderID: "anthropic" },
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", subProviderID: "openrouter" },
    ] as const;

    const result = visibleModelOptionsForPicker(
      "opencode",
      opencodeOptions,
      [opencodeOptions[0]],
      "",
    );
    expect(result).toEqual(opencodeOptions);
  });
});
