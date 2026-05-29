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
});

describe("getSubProviderDisplayName integration", () => {
  it("normalizes Pi provider IDs the same way as the shared utility", () => {
    expect(getSubProviderDisplayName("openai")).toBe("OpenAI");
    expect(getSubProviderDisplayName("OpenAI")).toBe("OpenAI");
    expect(getSubProviderDisplayName("open-ai")).toBe("OpenAI");
    expect(getSubProviderDisplayName("azure_openai")).toBe("Azure");
  });
});
