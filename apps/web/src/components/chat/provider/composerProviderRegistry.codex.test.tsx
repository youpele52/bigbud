import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import { describe, expect, it } from "vitest";

import { getComposerProviderState } from "./composerProviderRegistry";

const CODEX_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
        { value: "future-depth", label: "Future Depth" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

describe("getComposerProviderState for Codex", () => {
  it("returns codex defaults when no codex draft options exist", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
      },
    });
  });

  it("normalizes codex dispatch options while preserving the selected effort", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "low",
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "low",
      modelOptionsForDispatch: {
        reasoningEffort: "low",
        fastMode: true,
      },
    });
  });

  it("preserves dynamic advertised codex efforts", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "  future-depth  ",
        },
      },
    });

    expect(state.promptEffort).toBe("future-depth");
    expect(state.modelOptionsForDispatch).toEqual({ reasoningEffort: "future-depth" });
  });

  it("preserves codex fast mode when it is the only active option", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
        fastMode: true,
      },
    });
  });

  it("preserves codex default effort explicitly in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
        fastMode: false,
      },
    });
  });
});
