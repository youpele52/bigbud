import { assert } from "@effect/vitest";
import { describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import type { ServerProvider, ServerSettings } from "@bigbud/contracts";

import { resolveTextGenByProbeStatus } from "./wsSettingsResolver";

function makeProvider(
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "provider" | "status">,
): ServerProvider {
  return {
    enabled: true,
    installed: true,
    version: "1.0.0",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function makeSettings(overrides?: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("resolveTextGenByProbeStatus", () => {
  it.each([
    {
      name: "keeps a ready selection",
      selection: { provider: "codex", model: "gpt-5.4-mini" } as const,
      providers: [makeProvider({ provider: "codex", status: "ready" })],
      expectedProvider: "codex",
    },
    {
      name: "falls back from a degraded provider",
      selection: { provider: "codex", model: "gpt-5.4-mini" } as const,
      providers: [
        makeProvider({ provider: "codex", status: "error", installed: false }),
        makeProvider({ provider: "claudeAgent", status: "ready" }),
      ],
      expectedProvider: "claudeAgent",
    },
    {
      name: "falls back from CLIProxy for unattended settings",
      selection: { provider: "cliProxy", model: "default" } as const,
      providers: [
        makeProvider({ provider: "cliProxy", status: "ready" }),
        makeProvider({ provider: "codex", status: "ready" }),
      ],
      expectedProvider: "codex",
    },
  ])("$name", ({ selection, providers, expectedProvider }) => {
    const result = resolveTextGenByProbeStatus(
      makeSettings({ textGenerationModelSelection: selection }),
      providers,
    );
    assert.strictEqual(result.textGenerationModelSelection.provider, expectedProvider);
  });

  it("waits for probes before resolving", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    assert.strictEqual(resolveTextGenByProbeStatus(settings, []), settings);
  });

  it("does not use disabled or degraded fallback providers", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "cliProxy", model: "default" },
    });
    const result = resolveTextGenByProbeStatus(settings, [
      makeProvider({ provider: "cliProxy", status: "ready" }),
      makeProvider({ provider: "codex", status: "error" }),
      makeProvider({ provider: "claudeAgent", status: "disabled", enabled: false }),
    ]);
    assert.strictEqual(result, settings);
  });

  it("does not mutate persisted settings when applying a runtime fallback", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "cliProxy", model: "default" },
    });
    const result = resolveTextGenByProbeStatus(settings, [
      makeProvider({ provider: "cliProxy", status: "error" }),
      makeProvider({ provider: "codex", status: "ready" }),
    ]);
    assert.notStrictEqual(result, settings);
    assert.strictEqual(settings.textGenerationModelSelection.provider, "cliProxy");
  });
});
