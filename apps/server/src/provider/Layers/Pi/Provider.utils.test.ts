import { describe, expect, it } from "vitest";

import { getSubProviderDisplayName } from "../../subProviderDisplayNames.ts";
import { buildPiModels } from "./Provider.utils.ts";

describe("buildPiModels", () => {
  it("sets group using getSubProviderDisplayName", () => {
    const models = buildPiModels(
      [
        {
          id: "gpt-4",
          name: "GPT-4",
          provider: "openai",
        },
        {
          id: "claude-3",
          name: "Claude 3",
          provider: "anthropic",
        },
        {
          id: "unknown-model",
          name: "Unknown Model",
          provider: "some-unknown-provider",
        },
      ],
      [],
    );

    expect(models).toHaveLength(3);
    expect(models[0]!.group).toBe("OpenAI");
    expect(models[1]!.group).toBe("Anthropic");
    expect(models[2]!.group).toBe("Some Unknown Provider");
  });

  it("resolves aliases in group", () => {
    const models = buildPiModels(
      [
        {
          id: "gpt-4",
          name: "GPT-4",
          provider: "open-ai",
        },
        {
          id: "gemini-pro",
          name: "Gemini Pro",
          provider: "google_gemini",
        },
      ],
      [],
    );

    expect(models[0]!.group).toBe("OpenAI");
    expect(models[1]!.group).toBe("Google");
  });

  it("trims model names received from Pi", () => {
    const upstream = {
      id: "google/gemma-4-26b-a4b",
      name: "Google: Gemma 4 26B A4B ",
      provider: "openrouter",
    } as const;
    const [model] = buildPiModels([upstream], []);

    expect(model?.name).toBe("Google: Gemma 4 26B A4B");
    expect(model?.slug).toBe(upstream.id);
    expect(model?.subProviderID).toBe(upstream.provider);
    expect(upstream).toEqual({
      id: "google/gemma-4-26b-a4b",
      name: "Google: Gemma 4 26B A4B ",
      provider: "openrouter",
    });
  });

  it("falls back to the unchanged model ID for a whitespace-only display name", () => {
    const [model] = buildPiModels(
      [{ id: "openrouter/google/gemma", name: " \t\n ", provider: "openrouter" }],
      [],
    );

    expect(model).toMatchObject({
      slug: "openrouter/google/gemma",
      name: "openrouter/google/gemma",
      subProviderID: "openrouter",
    });
  });

  it("derives model-specific thinking levels from Pi metadata", () => {
    const [reasoning, nonReasoning] = buildPiModels(
      [
        {
          id: "reasoning",
          name: "Reasoning",
          provider: "openai",
          reasoning: true,
          thinkingLevelMap: { minimal: null, xhigh: "xhigh" },
        },
        {
          id: "plain",
          name: "Plain",
          provider: "openai",
          reasoning: false,
          thinkingLevelMap: { xhigh: "xhigh" },
        },
      ],
      [],
    );

    expect(reasoning?.capabilities?.reasoningEffortLevels.map((option) => option.value)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(nonReasoning?.capabilities?.reasoningEffortLevels.map((option) => option.value)).toEqual(
      ["off"],
    );
  });
});

describe("getSubProviderDisplayName integration", () => {
  it("normalizes Pi provider IDs the same way as the shared utility", () => {
    expect(getSubProviderDisplayName("openai")).toBe("OpenAI");
    expect(getSubProviderDisplayName("OpenAI")).toBe("OpenAI");
    expect(getSubProviderDisplayName("open-ai")).toBe("OpenAI");
    expect(getSubProviderDisplayName("azure_openai")).toBe("Azure");
  });
});
