import { describe, expect, it } from "vitest";

import { buildAcpEffortLevels, resolveAcpEffortChoice } from "./acpSessionEffort.ts";

const empty = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

describe("ACP effort config", () => {
  it("preserves exact choice IDs and does not label the current session value as default", () => {
    const capabilities = buildAcpEffortLevels(
      [
        {
          id: "reasoning",
          name: "Reasoning",
          category: "model_option",
          type: "select",
          currentValue: "max",
          options: [
            { value: "low", name: "Low" },
            { value: "max", name: "Max" },
          ],
        } as never,
      ],
      empty,
    );

    expect(capabilities.reasoningEffortLevels).toEqual([
      { value: "low", label: "Low" },
      { value: "max", label: "Max" },
    ]);
    expect(capabilities.effortMetadataStatus).toBe("verified-supported");
  });

  it("maps a unique legacy alias onto the live ACP value", () => {
    const option = {
      id: "effort",
      name: "Effort",
      category: "model_option",
      type: "select",
      options: [{ value: "max", name: "Max" }],
    } as never;
    expect(resolveAcpEffortChoice(option, "xhigh")).toBe("max");
    expect(resolveAcpEffortChoice(option, "max")).toBe("max");
  });

  it("discovers thought levels even when the ACP ID has no effort keyword", () => {
    const capabilities = buildAcpEffortLevels(
      [
        {
          id: "depth",
          name: "Depth",
          category: "thought_level",
          type: "select",
          options: [{ value: "deep", name: "Deep" }],
        } as never,
      ],
      empty,
    );

    expect(capabilities.reasoningEffortLevels).toEqual([{ value: "deep", label: "Deep" }]);
    expect(capabilities.effortMetadataStatus).toBe("verified-supported");
  });
});
