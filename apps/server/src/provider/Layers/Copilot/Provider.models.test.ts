import type { ModelInfo } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";

import { resolveCopilotModels } from "./Provider.ts";

describe("resolveCopilotModels", () => {
  it("offers Auto for authenticated accounts with no selectable models", () => {
    expect(resolveCopilotModels([], true, [])).toMatchObject([
      {
        slug: "auto",
        name: "Auto",
        isCustom: false,
        capabilities: { reasoningEffortLevels: [], supportsFastMode: false },
      },
    ]);
  });

  it("does not offer Auto to unauthenticated accounts", () => {
    expect(resolveCopilotModels([], false, [])).toEqual([]);
  });

  it("preserves a nonempty live catalog without adding Auto", () => {
    const model = {
      id: "test-model",
      name: "Test model",
      capabilities: {
        supports: { vision: false, reasoningEffort: false },
        limits: { max_context_window_tokens: 1_000 },
      },
    } as ModelInfo;
    expect(resolveCopilotModels([model], true, []).map(({ slug }) => slug)).toEqual(["test-model"]);
  });

  it("retains custom models and deduplicates a configured Auto model", () => {
    expect(
      resolveCopilotModels([], true, ["auto", "custom-model"]).map(({ slug, isCustom }) => ({
        slug,
        isCustom,
      })),
    ).toEqual([
      { slug: "auto", isCustom: false },
      { slug: "custom-model", isCustom: true },
    ]);
  });
});
