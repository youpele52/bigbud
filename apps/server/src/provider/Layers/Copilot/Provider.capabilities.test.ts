import type { ModelInfo } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";

import { mapCopilotModelCapabilities } from "./Provider.ts";

function model(supportsReasoningEffort: boolean, supportedReasoningEfforts?: unknown): ModelInfo {
  return {
    id: "test-model",
    name: "Test model",
    capabilities: {
      supports: { vision: false, reasoningEffort: supportsReasoningEffort },
      limits: { max_context_window_tokens: 1_000 },
    },
    ...(supportedReasoningEfforts === undefined
      ? {}
      : ({ supportedReasoningEfforts } as Partial<ModelInfo>)),
  } as ModelInfo;
}

describe("Copilot reasoning capability mapping", () => {
  it("keeps an omitted SDK list unavailable", () => {
    expect(mapCopilotModelCapabilities(model(true)).effortMetadataStatus).toBe("unknown");
  });

  it("treats an explicit empty SDK list as unsupported", () => {
    const capabilities = mapCopilotModelCapabilities(model(true, []));
    expect(capabilities.effortMetadataStatus).toBe("verified-unsupported");
    expect(capabilities.reasoningEffortLevels).toEqual([]);
  });

  it("treats an explicit reasoning denial as unsupported", () => {
    expect(mapCopilotModelCapabilities(model(false)).effortMetadataStatus).toBe(
      "verified-unsupported",
    );
  });

  it("keeps malformed SDK capability flags unavailable", () => {
    const malformed = model(true) as unknown as {
      capabilities: { supports: { reasoningEffort: unknown } };
    };
    malformed.capabilities.supports.reasoningEffort = "yes";
    expect(mapCopilotModelCapabilities(malformed as ModelInfo).effortMetadataStatus).toBe(
      "unknown",
    );
  });
});
