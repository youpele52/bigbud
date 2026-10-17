/** Provider telemetry must not silently rewrite an explicit text-generation preference. */
import type { ServerProvider, ServerSettings } from "@bigbud/contracts";

export function resolveTextGenByProbeStatus(
  settings: ServerSettings,
  _providers: ReadonlyArray<ServerProvider>,
): ServerSettings {
  return settings;
}
