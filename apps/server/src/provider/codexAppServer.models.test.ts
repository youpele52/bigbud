import { describe, expect, it } from "vitest";

import {
  parseCodexModelCapabilities,
  parseCodexModelsResult,
  parseCodexReasoningEffortLevels,
} from "./codexAppServer.models";

describe("parseCodexReasoningEffortLevels", () => {
  it("trims, deduplicates, and preserves effort order", () => {
    expect(
      parseCodexReasoningEffortLevels({
        supportedReasoningEfforts: [
          { reasoningEffort: " low " },
          " medium ",
          { reasoningEffort: "low" },
          " ",
          null,
          { reasoningEffort: "xhigh" },
          " max ",
          { reasoningEffort: "ultra" },
          " future-depth ",
        ],
        defaultReasoningEffort: " medium ",
      }),
    ).toEqual([
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium", isDefault: true },
      { value: "xhigh", label: "Extra High" },
      { value: "max", label: "Max" },
      { value: "ultra", label: "Ultra" },
      { value: "future-depth", label: "Future Depth" },
    ]);
  });

  it("returns no levels for malformed effort data", () => {
    expect(
      parseCodexReasoningEffortLevels({
        supportedReasoningEfforts: [null, false, 4, {}, { reasoningEffort: "  " }],
        defaultReasoningEffort: " high ",
      }),
    ).toEqual([]);
  });
});

describe("parseCodexModelCapabilities", () => {
  it("preserves fast-mode support independently of effort levels", () => {
    expect(
      parseCodexModelCapabilities({
        supportedReasoningEfforts: [],
        additionalSpeedTiers: [" fast "],
      }),
    ).toMatchObject({
      reasoningEffortLevels: [],
      supportsFastMode: true,
    });
  });
});

describe("parseCodexModelsResult", () => {
  it("distinguishes an authoritative empty catalog from malformed top-level data", () => {
    expect(parseCodexModelsResult({ data: [] })).toEqual([]);
    expect(parseCodexModelsResult({})).toBeUndefined();
    expect(parseCodexModelsResult({ data: null })).toBeUndefined();
    expect(parseCodexModelsResult({ data: {} })).toBeUndefined();
    expect(parseCodexModelsResult(null)).toBeUndefined();
  });

  it("trims model fields, preserves order, and skips hidden or malformed models", () => {
    expect(
      parseCodexModelsResult({
        data: [
          {
            model: " model-a ",
            displayName: " Model A ",
            supportedReasoningEfforts: ["low", "high", "low"],
          },
          { model: " hidden-model ", hidden: true },
          { model: " ", id: " model-b ", displayName: " " },
          null,
          { displayName: "missing model" },
          { id: " model-c ", hidden: false },
        ],
      }),
    ).toEqual([
      {
        slug: "model-a",
        name: "Model A",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "model-b",
        name: "model-b",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "model-c",
        name: "model-c",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });
});
