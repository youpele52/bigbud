import type { CopilotSettings } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { makeCopilotInitialSnapshot } from "./Provider";

function makeSettings(enabled: boolean): CopilotSettings {
  return { enabled, binaryPath: "copilot", customModels: ["custom-model"] };
}

describe("makeCopilotInitialSnapshot", () => {
  it("returns an immediate checking snapshot without probing the SDK", () => {
    const snapshot = makeCopilotInitialSnapshot(makeSettings(true));

    expect(snapshot).toMatchObject({
      provider: "copilot",
      enabled: true,
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking GitHub Copilot availability...",
    });
    expect(snapshot.models.some((model) => model.isCustom)).toBe(true);
  });

  it("retains the disabled snapshot", () => {
    const snapshot = makeCopilotInitialSnapshot(makeSettings(false));

    expect(snapshot).toMatchObject({
      enabled: false,
      installed: false,
      status: "disabled",
      message: "GitHub Copilot is disabled in bigbud settings.",
    });
  });
});
