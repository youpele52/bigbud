import type { CursorSettings, ModelCapabilities } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { buildCursorProviderSnapshot, parseCursorAboutOutput } from "./Provider.about.ts";

const settings: CursorSettings = {
  enabled: true,
  binaryPath: "agent",
  apiEndpoint: "",
  customModels: [],
};

const capabilities: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

describe("Cursor provider about snapshot", () => {
  it("keeps an otherwise successful old-version about probe eligible for discovery", () => {
    const parsed = parseCursorAboutOutput({
      stdout: JSON.stringify({ cliVersion: "2025.01.01", userEmail: "user@example.test" }),
      stderr: "",
      code: 0,
    });
    const snapshot = buildCursorProviderSnapshot({
      checkedAt: "2026-09-03T00:00:00.000Z",
      cursorSettings: settings,
      parsed,
      discoveredModels: [
        { slug: "cursor-fast", name: "Cursor Fast", isCustom: false, capabilities },
      ],
    });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.models.map((model) => model.slug)).toEqual(["cursor-fast"]);
  });

  it("retains discovery failures as warnings without discarding about status", () => {
    const snapshot = buildCursorProviderSnapshot({
      checkedAt: "2026-09-03T00:00:00.000Z",
      cursorSettings: settings,
      parsed: {
        version: "2026.04.08",
        status: "ready",
        auth: { status: "authenticated" },
      },
      discoveryWarning: "Cursor ACP model discovery failed.",
    });

    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toBe("Cursor ACP model discovery failed.");
  });
});
