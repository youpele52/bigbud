import type { ClaudeSettings } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { makeClaudeInitialSnapshot } from "./Provider.initialSnapshot";

function makeSettings(enabled: boolean): ClaudeSettings {
  return {
    enabled,
    binaryPath: "claude",
    customModels: ["custom-model"],
    rollout: {
      modernTaskExposure: true,
      boundedHookProgress: true,
      forwardedSubagentText: false,
      mcpControls: true,
      fileCheckpointRewind: false,
      nativeFork: false,
    },
  };
}

describe("makeClaudeInitialSnapshot", () => {
  it("returns an immediate checking snapshot with fallback model metadata", () => {
    const snapshot = makeClaudeInitialSnapshot(makeSettings(true));

    expect(snapshot).toMatchObject({
      provider: "claudeAgent",
      enabled: true,
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Claude availability...",
      modelDiscovery: { status: "unavailable", source: "fallback", durationMs: 0 },
    });
    expect(snapshot.models.some((model) => model.isCustom)).toBe(true);
  });

  it("retains the disabled snapshot", () => {
    const snapshot = makeClaudeInitialSnapshot(makeSettings(false));

    expect(snapshot).toMatchObject({
      enabled: false,
      installed: false,
      status: "disabled",
      message: "Claude is disabled in bigbud settings.",
    });
  });
});
