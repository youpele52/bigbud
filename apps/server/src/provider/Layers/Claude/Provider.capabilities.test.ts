import { describe, expect, it } from "vitest";

import {
  classifyClaudeModelDiscovery,
  dedupeClaudeModels,
  DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  getClaudeModelCapabilities,
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
});
