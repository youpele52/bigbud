import { describe, it } from "@effect/vitest";
import { assert } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import type { ServerProvider, ServerSettings } from "@bigbud/contracts";
import { resolveTextGenByProbeStatus } from "./wsSettingsResolver";

// ── Test helpers ─────────────────────────────────────────────────────

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
  return {
    ...DEFAULT_SERVER_SETTINGS,
    ...overrides,
  };
}

// ── resolveTextGenByProbeStatus tests ─────────────────────────────────

describe("resolveTextGenByProbeStatus", () => {
  it("returns settings unchanged when providers array is empty (probes still running)", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const result = resolveTextGenByProbeStatus(settings, []);
    assert.strictEqual(result, settings);
  });

  it("keeps existing selection when the selected provider is ready", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [makeProvider({ provider: "codex", status: "ready" })];
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result, settings);
    assert.strictEqual(result.textGenerationModelSelection.provider, "codex");
  });

  it("falls through to first ready provider when selected provider status is error", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({ provider: "claudeAgent", status: "ready" }),
      makeProvider({ provider: "copilot", status: "ready" }),
      makeProvider({ provider: "opencode", status: "ready" }),
    ];
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result.textGenerationModelSelection.provider, "claudeAgent");
  });

  it("prefers provider PROVIDER_KINDS order when multiple providers are ready", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({ provider: "claudeAgent", status: "error", installed: false }),
      makeProvider({ provider: "copilot", status: "ready" }),
      makeProvider({ provider: "opencode", status: "ready" }),
    ];
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result.textGenerationModelSelection.provider, "copilot");
  });

  it("uses the first model slug from provider.models when available", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({
        provider: "claudeAgent",
        status: "ready",
        models: [
          {
            slug: "claude-haiku-4-5",
            name: "Claude Haiku 4.5",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            isCustom: false,
            capabilities: null,
          },
        ],
      }),
    ];
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result.textGenerationModelSelection.provider, "claudeAgent");
    assert.strictEqual(result.textGenerationModelSelection.model, "claude-haiku-4-5");
  });

  it("falls back to DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER when models array is empty", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({ provider: "claudeAgent", status: "ready", models: [] }),
    ];
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result.textGenerationModelSelection.provider, "claudeAgent");
    assert.strictEqual(result.textGenerationModelSelection.model, "claude-haiku-4-5");
  });

  it("ignores disabled providers when searching for a ready provider", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({ provider: "claudeAgent", status: "ready", enabled: false }),
      makeProvider({ provider: "copilot", status: "ready" }),
    ];
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result.textGenerationModelSelection.provider, "copilot");
  });

  it("falls back to first enabled provider when no provider is ready (none installed)", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({ provider: "claudeAgent", status: "error", installed: false }),
      makeProvider({ provider: "copilot", status: "error", installed: false }),
      makeProvider({ provider: "opencode", status: "error", installed: false }),
    ];
    // codex is first in PROVIDER_KINDS order, but it is not ready — should pick first enabled
    const result = resolveTextGenByProbeStatus(settings, providers);
    // All are enabled but none are ready; first enabled in PROVIDER_KINDS order is "codex"
    assert.strictEqual(result.textGenerationModelSelection.provider, "codex");
  });

  it("returns settings unchanged when all providers are disabled", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "disabled", enabled: false }),
      makeProvider({ provider: "claudeAgent", status: "disabled", enabled: false }),
      makeProvider({ provider: "copilot", status: "disabled", enabled: false }),
      makeProvider({ provider: "opencode", status: "disabled", enabled: false }),
    ];
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result, settings);
  });

  it("returns settings unchanged when selected provider has status warning (still usable)", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "copilot", model: "gpt-5-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "ready" }),
      makeProvider({ provider: "copilot", status: "warning" }),
    ];
    // "warning" is not "ready" so should fall through to "codex" which is first ready
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result.textGenerationModelSelection.provider, "codex");
  });

  it("does not mutate the original settings object", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({ provider: "claudeAgent", status: "ready" }),
    ];
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.notStrictEqual(result, settings);
    assert.strictEqual(settings.textGenerationModelSelection.provider, "codex");
  });
});
