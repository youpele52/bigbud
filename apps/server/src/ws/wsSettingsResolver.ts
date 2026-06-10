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
 * No fallback: if the selected provider is unusable, the original selection is
 * returned unchanged so the UI can display the error/warning state explicitly.
 *
 * @module wsSettingsResolver
 */
import type { ServerProvider, ServerSettings } from "@bigbud/contracts";

/**
 * Re-resolves `settings.textGenerationModelSelection` using live probe status.
 *
 * Resolution order:
 * 1. If the currently selected provider snapshot is `enabled && status === "ready"`, keep it.
 * 2. Otherwise return settings unchanged — the UI will display the provider's
 *    actual status (warning/error) and block selection rather than silently
 *    falling back to another provider.
 * 3. If no providers snapshots are available (empty array), return settings unchanged —
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

  // No fallback: return unchanged so the UI can show the actual provider status
  // (warning/error) and prevent selection rather than silently switching providers.
  return settings;
}
