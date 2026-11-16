import {
  configureMobileGatewayLifecycle,
  assertMobileGatewayOwnerAvailable,
  runMobileGatewayOwnerOperation,
} from "./backend/mobileGatewayLifecycle";
import { configureMobileGatewayPreparation } from "./backend/mobileGatewayPreparation";
import {
  desktopMobileGatewayPort,
  desktopMobileGatewayOrigin,
  desktopMobileGatewayStatus,
  retryDesktopMobileGateway,
  prepareDesktopMobileGateway,
} from "./backend/mobileGatewayOwner";
import * as Path from "node:path";

import {
  type DesktopTailscaleRemoteAccessStatus,
  disableDesktopTailscaleRemoteAccess,
  enableDesktopTailscaleRemoteAccess,
  getDesktopTailscaleRemoteAccessStatus,
} from "./backend/tailscaleRemoteAccess";
import { createFileServeOwnershipStore } from "./backend/tailscaleRemoteAccess.ownership";

const SERVE_OWNERSHIP_FILE = "tailscale-serve-owner.json";

/**
 * Owns the mobile backend origin advertised in pairing links: the Tailscale
 * HTTPS address while Serve exposes this backend, otherwise the local origin.
 * Status/enable/disable keep that origin in sync and record Serve ownership.
 */
export function makeDesktopMobileRemoteAccess(input: {
  readonly baseDir: string;
  readonly getBackendPort: () => number;
  readonly getBackendHost: () => string;
  readonly getIsQuitting?: () => boolean;
}) {
  configureMobileGatewayLifecycle(input.getIsQuitting ?? (() => false));
  const targetPort = () => desktopMobileGatewayPort() ?? input.getBackendPort();
  const ownership = createFileServeOwnershipStore(Path.join(input.baseDir, SERVE_OWNERSHIP_FILE));
  let localBaseUrl = "";
  let mobileBackendBaseUrl = "";

  const adopt = (status: DesktopTailscaleRemoteAccessStatus) => {
    const gateway = desktopMobileGatewayStatus();
    if (gateway !== null && gateway !== "ready")
      status = {
        ...status,
        serving: false,
        error: desktopMobileGatewayOrigin()
          ? "Mobile gateway is unavailable. Enable remote access again to retry."
          : "Mobile gateway setup is unavailable. Restart the desktop to retry.",
      };
    mobileBackendBaseUrl =
      desktopMobileGatewayOrigin() ??
      (status.serving && status.remoteBaseUrl ? status.remoteBaseUrl : localBaseUrl);
    return status;
  };

  return {
    prepareGateway: async (serverSettingsPath: string, allowPrototype = false) => {
      if (!allowPrototype || !process.env.BIGBUD_MOBILE_GATEWAY_BINARY) return;
      configureMobileGatewayPreparation(async () => {
        const status = await getDesktopTailscaleRemoteAccessStatus(
          targetPort(),
          undefined,
          ownership,
        );
        if (!status.online || !status.remoteBaseUrl)
          throw new Error("Mobile gateway requires available tailnet status.");
        await prepareDesktopMobileGateway({
          serverSettingsPath,
          backendPort: input.getBackendPort(),
          backendHost: input.getBackendHost(),
          externalOrigin: status.remoteBaseUrl,
          ownership,
        });
      });
    },
    setLocalBaseUrl: (url: string) => {
      localBaseUrl = url;
      mobileBackendBaseUrl = desktopMobileGatewayOrigin() ?? url;
    },
    getMobileBackendBaseUrl: () => desktopMobileGatewayOrigin() ?? mobileBackendBaseUrl,
    getTailscaleRemoteAccessStatus: async () =>
      adopt(await getDesktopTailscaleRemoteAccessStatus(targetPort(), undefined, ownership)),
    enableTailscaleRemoteAccess: () =>
      runMobileGatewayOwnerOperation(async () => {
        const gateway = desktopMobileGatewayStatus();
        if (gateway !== null && gateway !== "ready") await retryDesktopMobileGateway();
        return adopt(
          await enableDesktopTailscaleRemoteAccess(
            targetPort(),
            undefined,
            ownership,
            undefined,
            assertMobileGatewayOwnerAvailable,
          ),
        );
      }),
    disableTailscaleRemoteAccess: () =>
      runMobileGatewayOwnerOperation(async () => {
        const status = await disableDesktopTailscaleRemoteAccess(
          targetPort(),
          undefined,
          ownership,
          assertMobileGatewayOwnerAvailable,
        );
        mobileBackendBaseUrl = desktopMobileGatewayOrigin() ?? localBaseUrl;
        return status;
      }),
  };
}
