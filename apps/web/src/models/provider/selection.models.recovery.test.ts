import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { describe, expect, it } from "vitest";
import { resolveAppModelSelection } from "./selection.models";

describe("model selection across discovery recovery", () => {
  it("does not rewrite a selected live Copilot ID through a legacy fallback alias", () => {
    const base: ServerProvider = {
      provider: "copilot",
      enabled: true,
      installed: true,
      version: "1",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-30T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    for (const slug of [undefined, "gpt-5", "gpt-6-astra"]) {
      const snapshot = {
        ...base,
        models: slug ? [{ slug, name: slug, isCustom: false, capabilities: null }] : [],
      };
      expect(
        resolveAppModelSelection("copilot", DEFAULT_UNIFIED_SETTINGS, [snapshot], "gpt-5.5"),
      ).toBe("gpt-5.5");
    }
  });
  it.each([
    "codex",
    "claudeAgent",
    "copilot",
    "cursor",
    "devin",
    "pi",
    "opencode",
    "kilocode",
  ] as const)(
    "keeps the selected %s model across pending, fallback, and live snapshots",
    (provider) => {
      const base: ServerProvider = {
        provider,
        enabled: true,
        installed: true,
        version: "1",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-09-30T00:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      };
      for (const slug of [undefined, "fallback-model", "new-live-model"]) {
        const snapshot = {
          ...base,
          models: slug ? [{ slug, name: slug, isCustom: false, capabilities: null }] : [],
        };
        expect(
          resolveAppModelSelection(
            provider,
            DEFAULT_UNIFIED_SETTINGS,
            [snapshot],
            "selected-model",
          ),
        ).toBe("selected-model");
      }
    },
  );
});
