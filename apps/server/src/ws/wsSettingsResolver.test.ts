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

  it("returns settings unchanged when selected provider status is error (no fallback)", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({ provider: "claudeAgent", status: "ready" }),
      makeProvider({ provider: "copilot", status: "ready" }),
      makeProvider({ provider: "opencode", status: "ready" }),
    ];
    // No fallback: keep the selected provider so UI can show error state
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result, settings);
    assert.strictEqual(result.textGenerationModelSelection.provider, "codex");
  });

  it("returns settings unchanged when models array is empty (no fallback)", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({ provider: "claudeAgent", status: "ready", models: [] }),
    ];
    // No fallback: keep the selected provider so UI can show error state
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result, settings);
    assert.strictEqual(result.textGenerationModelSelection.provider, "codex");
  });

  it("returns settings unchanged when selected provider is disabled (no fallback)", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({ provider: "claudeAgent", status: "ready", enabled: false }),
      makeProvider({ provider: "copilot", status: "ready" }),
    ];
    // No fallback: keep the selected provider so UI can show error state
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result, settings);
    assert.strictEqual(result.textGenerationModelSelection.provider, "codex");
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

  it("returns settings unchanged when selected provider has status warning (no fallback)", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "devin", model: "default" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "ready" }),
      makeProvider({ provider: "devin", status: "warning" }),
    ];
    // No fallback: keep the selected provider so UI can show warning state
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result, settings);
    assert.strictEqual(result.textGenerationModelSelection.provider, "devin");
  });

  it("returns settings unchanged when selected provider has status error (no fallback)", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "devin", model: "default" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "ready" }),
      makeProvider({ provider: "devin", status: "error" }),
    ];
    // No fallback: keep the selected provider so UI can show error state
    const result = resolveTextGenByProbeStatus(settings, providers);
    assert.strictEqual(result, settings);
    assert.strictEqual(result.textGenerationModelSelection.provider, "devin");
  });

  it("does not mutate the original settings object when returning unchanged", () => {
    const settings = makeSettings({
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const providers = [
      makeProvider({ provider: "codex", status: "error", installed: false }),
      makeProvider({ provider: "claudeAgent", status: "ready" }),
    ];
    const result = resolveTextGenByProbeStatus(settings, providers);
    // No fallback: returns the same object when selected provider is not ready
    assert.strictEqual(result, settings);
    assert.strictEqual(settings.textGenerationModelSelection.provider, "codex");
  });
});
