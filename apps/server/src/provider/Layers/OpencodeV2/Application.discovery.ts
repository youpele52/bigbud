import { buildServerProvider } from "../../providerSnapshot.ts";
import { discoverV2SharedService } from "./SharedService.discovery.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";
import { v2SharedRegistrationFile } from "./SharedService.registration.ts";
import type { V2ConsentAuthority } from "./Application.consent.ts";

/** Preconsent status never acquires a manager/lease or starts lazy SSE/Location activation. */
export async function readV2HealthSnapshot(
  config: { serviceFile?: string },
  authority: V2ConsentAuthority,
) {
  const permit = authority.capture(true);
  try {
    let version: string | undefined;
    let message =
      "Native service trust consent required: Location activation may load/install configured plugins and native tools run as your user, not in a sandbox.";
    try {
      version = (
        await discoverV2SharedService({
          file: config.serviceFile?.trim() || v2SharedRegistrationFile(),
          signal: permit.signal,
        })
      ).version;
    } catch (error) {
      if (error instanceof V2SharedServiceError) {
        version = error.version;
        message = error.message;
      } else
        message = "V2 native health/contract discovery unavailable; no native work was submitted.";
    }
    permit.assertCurrent();
    return {
      permit,
      snapshot: buildServerProvider({
        provider: "opencodeV2",
        enabled: true,
        checkedAt: new Date().toISOString(),
        models: [],
        probe: {
          installed: version !== undefined,
          version: version ?? null,
          status: "warning",
          auth: { status: "unknown" },
          message,
        },
      }),
    };
  } catch (error) {
    permit.release();
    throw error;
  }
}
