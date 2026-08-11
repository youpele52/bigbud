import type { CodexSettings } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { makeCodexInitialSnapshot } from "./Provider.initialSnapshot";

function makeSettings(enabled: boolean): CodexSettings {
  return { enabled, binaryPath: "codex", homePath: "", customModels: ["custom-model"] };
}

describe("makeCodexInitialSnapshot", () => {
  it("returns an immediate checking snapshot without executing Codex", () => {
    const snapshot = makeCodexInitialSnapshot(makeSettings(true));

    expect(snapshot).toMatchObject({
      provider: "codex",
      enabled: true,
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Codex availability...",
    });
    expect(snapshot.models.some((model) => model.isCustom)).toBe(true);
  });

  it("retains the disabled snapshot", () => {
    const snapshot = makeCodexInitialSnapshot(makeSettings(false));

    expect(snapshot).toMatchObject({
      enabled: false,
      installed: false,
      status: "disabled",
      message: "Codex is disabled in bigbud settings.",
    });
  });
});
