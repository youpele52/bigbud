import { describe, expect, it } from "vitest";

import { resolveEffort } from "./model.effort";

describe("resolveEffort provenance", () => {
  it("does not synthesize a default from a provisional seed", () => {
    expect(
      resolveEffort(
        {
          reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
          effortMetadataStatus: "seed",
          effortMetadataOrigin: "seed",
        },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("keeps an explicit custom selection while metadata is only a seed", () => {
    expect(
      resolveEffort(
        {
          reasoningEffortLevels: [
            { value: "high", label: "High", isDefault: true },
            { value: "medium", label: "Medium" },
            { value: "low", label: "Low" },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
          effortMetadataStatus: "seed",
          effortMetadataOrigin: "seed",
        },
        "custom-xhigh",
      ),
    ).toBe("custom-xhigh");
  });

  it("omits effort when verified options exist without a default", () => {
    expect(
      resolveEffort(
        {
          reasoningEffortLevels: [
            { value: "none", label: "None" },
            { value: "xhigh", label: "Extra High" },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
          effortMetadataStatus: "verified-supported",
          effortMetadataOrigin: "live",
        },
        undefined,
      ),
    ).toBeUndefined();
  });
});
