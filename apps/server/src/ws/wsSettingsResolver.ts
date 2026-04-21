/**
 * wsSettingsResolver - Probe-status-aware text generation model selection resolution.
 *
 * `serverSettings.ts` persists and resolves `textGenerationModelSelection` based
 * only on the per-provider `enabled` flag (user config).  This module provides a
 * second resolution pass that additionally gates on the live probe `status` field
 * from `ProviderRegistry` snapshots.
 *
 * It is applied at the WS transport layer (both the initial `loadServerConfig`
 * snapshot and the `settingsUpdated` stream) so clients always receive a
 * consistent, probe-status-correct selection — without mutating persisted state.
 *
 * @module wsSettingsResolver
 */
import type { ModelSelection, ServerProvider, ServerSettings } from "@bigbud/contracts";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER, PROVIDER_KINDS } from "@bigbud/contracts";

/**
 * Re-resolves `settings.textGenerationModelSelection` using live probe status.
 *
 * Resolution order:
 * 1. If the currently selected provider snapshot is `enabled && status === "ready"`, keep it.
 * 2. Otherwise find the first provider (in `PROVIDER_KINDS` order) that is `enabled && status === "ready"`.
 * 3. If none are ready, fall back to the first `enabled` provider (mirrors the existing
 *    `resolveTextGenerationProvider` logic so callers see a consistent error state).
 * 4. If no providers snapshots are available (empty array), return settings unchanged —
 *    probes may still be running; the client will receive an updated event once they finish.
 *
 * Persisted user choices are authoritative: this override is view-only and is never
 * written back to disk.
 */
export function resolveTextGenByProbeStatus(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
): ServerSettings {
  if (providers.length === 0) {
    return settings;
  }

  const selectedKind = settings.textGenerationModelSelection.provider;
  const selectedSnapshot = providers.find((p) => p.provider === selectedKind);

  // Current selection is ready — nothing to override.
  if (selectedSnapshot?.enabled && selectedSnapshot.status === "ready") {
    return settings;
  }

  // Find the first ready provider (probe-status-gated).
  const firstReady = PROVIDER_KINDS.map((kind) => providers.find((p) => p.provider === kind))
    .filter((p): p is ServerProvider => p !== undefined)
    .find((p) => p.enabled && p.status === "ready");

  if (firstReady) {
    // Prefer the provider's first model slug when available, fall back to the static default.
    const model =
      firstReady.models[0]?.slug ??
      DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[firstReady.provider];
    return {
      ...settings,
      textGenerationModelSelection: {
        provider: firstReady.provider,
        model,
      } as ModelSelection,
    };
  }

  // No provider is ready yet — fall back to the first enabled provider so the
  // client can still display a meaningful "not installed / not authenticated" state.
  const firstEnabled = PROVIDER_KINDS.map((kind) => providers.find((p) => p.provider === kind))
    .filter((p): p is ServerProvider => p !== undefined)
    .find((p) => p.enabled);

  if (firstEnabled) {
    const model =
      firstEnabled.models[0]?.slug ??
      DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[firstEnabled.provider];
    return {
      ...settings,
      textGenerationModelSelection: {
        provider: firstEnabled.provider,
        model,
      } as ModelSelection,
    };
  }

  // All providers are disabled or unknown — return unchanged (callers report error state).
  return settings;
}
