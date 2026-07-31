/**
 * Resolve server-side text generation settings against live provider telemetry.
 * Persisted settings remain untouched; only the runtime snapshot is adjusted.
 */
import type { ServerProvider, ServerSettings } from "@bigbud/contracts";

import { resolveProviderWorkload } from "../provider/providerWorkloadSupport.ts";

export function resolveTextGenByProbeStatus(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
): ServerSettings {
  if (providers.length === 0) return settings;

  const resolution = resolveProviderWorkload({
    requested: settings.textGenerationModelSelection,
    workload: "unattendedTextGeneration",
    availableProviders: providers,
  });
  if (
    !resolution.actual ||
    resolution.actual.provider === settings.textGenerationModelSelection.provider
  ) {
    return settings;
  }
  return {
    ...settings,
    textGenerationModelSelection: resolution.actual,
  };
}
