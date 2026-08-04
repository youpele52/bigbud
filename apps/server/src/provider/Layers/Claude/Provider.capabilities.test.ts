import { describe, expect, it } from "vitest";

import {
  classifyClaudeModelDiscovery,
  dedupeClaudeModels,
  DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  getClaudeModelCapabilities,
  mapClaudeModel,
  resolveClaudeModelDiscovery,
} from "./Provider.capabilities.ts";

describe("Claude model discovery", () => {
  it.each(["opus", "opus-4.6", "claude-opus-4.6", "claude-opus-4-6"])(
    "resolves Opus aliases to the same capabilities (%s)",
    (model) => {
      expect(getClaudeModelCapabilities(model)).toEqual(getClaudeModelCapabilities("opus"));
      expect(getClaudeModelCapabilities(model).supportsFastMode).toBe(true);
    },
  );

  it("deduplicates live and custom models case-insensitively", () => {
    expect(
      dedupeClaudeModels([
        {
          slug: "claude-sonnet",
          name: "Sonnet",
          isCustom: false,
          capabilities: DEFAULT_CLAUDE_MODEL_CAPABILITIES,
        },
        {
          slug: "CLAUDE-SONNET",
          name: "Duplicate",
          isCustom: true,
          capabilities: DEFAULT_CLAUDE_MODEL_CAPABILITIES,
        },
        {
          slug: "custom",
          name: "Custom",
          isCustom: true,
          capabilities: DEFAULT_CLAUDE_MODEL_CAPABILITIES,
        },
      ]),
    ).toHaveLength(2);
  });

  it("preserves a successful empty discovery result", () => {
    expect(dedupeClaudeModels([])).toEqual([]);
  });

  it.each([
    [[], "empty"],
    [[{ value: "claude-sonnet" }], "live"],
    [undefined, "unavailable"],
    ["invalid", "invalid"],
  ] as const)("classifies model discovery state (%s)", (models, status) => {
    expect(
      classifyClaudeModelDiscovery({ models, durationMs: 91_234, version: "0.3.219" }),
    ).toEqual({
      status,
      source: "sdk",
      version: "0.3.219",
      durationMs: 60_000,
    });
  });

  it("rejects malformed live discovery entries before mapping", () => {
    expect(resolveClaudeModelDiscovery({ models: [{ value: "opus" }], durationMs: 12 })).toEqual({
      models: [],
      modelDiscovery: {
        status: "invalid",
        source: "sdk",
        version: "0.3.219",
        durationMs: 12,
      },
    });
  });

  it("keeps built-in fallback effort metadata outside live discovery", () => {
    expect(
      getClaudeModelCapabilities("claude-sonnet-4-6").reasoningEffortLevels.map(
        (option) => option.value,
      ),
    ).toEqual(["low", "medium", "high"]);
  });

  it.each([
    ["claude-sonnet-4-6", ["low", "medium", "high"]],
    ["claude-opus-4-6", ["low", "medium", "high", "max"]],
  ])("uses built-in effort fallback for %s when SDK metadata is omitted", (value, effortLevels) => {
    const model = mapClaudeModel({
      value,
      displayName: "Claude",
      description: "Claude model",
    });

    expect(model.capabilities?.reasoningEffortLevels.map((option) => option.value)).toEqual(
      effortLevels,
    );
  });

  it("honors an explicit SDK effort capability denial", () => {
    const model = mapClaudeModel({
      value: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      description: "Sonnet",
      supportsEffort: false,
      supportedEffortLevels: ["high"],
    });

    expect(model.capabilities?.reasoningEffortLevels).toEqual([]);
  });

  it("keeps SDK-advertised xhigh as a typed native effort level", () => {
    const model = mapClaudeModel({
      value: "claude-opus-4-7",
      displayName: "Claude Opus 4.7",
      description: "Opus",
      supportsEffort: true,
      supportedEffortLevels: ["high", "xhigh", "max"],
    });

    expect(model.capabilities?.reasoningEffortLevels.map((option) => option.value)).toEqual([
      "high",
      "xhigh",
      "max",
    ]);
    expect(model.capabilities?.workflowModes).toEqual([{ value: "ultracode", label: "Ultracode" }]);
  });

  it("keeps Haiku without native effort when SDK metadata is omitted", () => {
    const model = mapClaudeModel({
      value: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      description: "Haiku",
    });

    expect(model.capabilities?.reasoningEffortLevels).toEqual([]);
    expect(model.capabilities?.supportsThinkingToggle).toBe(true);
  });

  it("preserves a future SDK-advertised effort without a local value list", () => {
    const result = resolveClaudeModelDiscovery({
      durationMs: 1,
      models: [
        {
          value: "claude-future",
          displayName: "Claude Future",
          description: "Future model",
          supportsEffort: true,
          supportedEffortLevels: ["high", "future-depth"],
        },
      ],
    });

    expect(
      result.models[0]?.capabilities?.reasoningEffortLevels.map((option) => option.value),
    ).toEqual(["high", "future-depth"]);
  });
});
