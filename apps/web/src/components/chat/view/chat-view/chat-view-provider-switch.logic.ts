import type { RuntimeMode } from "@bigbud/contracts";

/**
 * When a provider publishes qualified access modes (e.g. Muse supports only
 * auto-accept-edits), selecting it must move an unsupported current mode to the
 * first qualified one; otherwise every send fails closed at session start.
 * Returns null when the current mode is already usable or unrestricted.
 */
export function resolveProviderSwitchRuntimeMode(input: {
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly currentRuntimeMode: RuntimeMode;
}): RuntimeMode | null {
  if (!input.supportedRuntimeModes || input.supportedRuntimeModes.length === 0) return null;
  return input.supportedRuntimeModes.includes(input.currentRuntimeMode)
    ? null
    : (input.supportedRuntimeModes[0] ?? null);
}

/**
 * Load-time clamp for an inherited mode (existing, continued or cloned
 * threads never re-pick their provider): only `full-access` — the global
 * default — downgrades to the provider's first qualified mode, which is
 * strictly less privilege and therefore fail-safe. A user-chosen stricter
 * mode such as `approval-required` is never silently upgraded.
 */
export function resolveInheritedFullAccessDowngrade(input: {
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly currentRuntimeMode: RuntimeMode;
}): RuntimeMode | null {
  if (input.currentRuntimeMode !== "full-access") return null;
  if (!input.supportedRuntimeModes || input.supportedRuntimeModes.length === 0) return null;
  if (input.supportedRuntimeModes.includes("full-access")) return null;
  return input.supportedRuntimeModes[0] ?? null;
}
