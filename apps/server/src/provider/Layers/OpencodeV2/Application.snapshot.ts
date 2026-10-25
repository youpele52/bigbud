import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import { hasOpencodeV2NativeTrust } from "@bigbud/shared/opencodeNativeTrust";
import { buildServerProvider } from "../../providerSnapshot.ts";
import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";

/** Accepted settings determine a safe cache fallback synchronously, without activating Location. */
export function invalidatedV2Snapshot(settings: Pick<ServerSettingsShape, "currentSnapshot">) {
  const config = settings.currentSnapshot?.()?.settings.providers.opencodeV2;
  const consentRequired =
    config &&
    resolveOpencodeV2ConnectionMode(config) === "shared" &&
    !hasOpencodeV2NativeTrust(config);
  return {
    ...buildServerProvider({
      provider: "opencodeV2",
      enabled: config?.enabled ?? false,
      checkedAt: new Date().toISOString(),
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: !config?.enabled
          ? "OpenCode v2 is disabled."
          : consentRequired
            ? "Native service trust consent required. Cached native status is invalid; refresh performs health-only discovery."
            : "OpenCode v2 settings changed. Refresh to verify current status; cached native catalog and auth are not authoritative.",
      },
    }),
    initialProbeComplete: false,
  };
}
