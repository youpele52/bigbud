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
import * as OS from "node:os";
import * as Path from "node:path";

import { resolveOwnershipBaseDir } from "@bigbud/shared/backendOwnership.paths";

import {
  type DesktopTailscaleRemoteAccessStatus,
  disableDesktopTailscaleRemoteAccess,
  enableDesktopTailscaleRemoteAccess,
  getDesktopTailscaleRemoteAccessStatus,
  takeOverDesktopTailscaleRemoteAccess,
} from "./backend/tailscaleRemoteAccess";
import { createFileServeOwnershipStore } from "./backend/tailscaleRemoteAccess.ownership";
import { createBigbudLockOwnerDetector } from "./backend/tailscaleRemoteAccess.takeover";

const SERVE_OWNERSHIP_FILE = "tailscale-serve-owner.json";

/** Every channel's state lives under the stable root (`~/.bigbud`, or `BIGBUD_HOME`). */
function bigbudStateRoots(): string[] {
  return [Path.join(OS.homedir(), ".bigbud"), resolveOwnershipBaseDir(process.env.BIGBUD_HOME)];
}

/**
 * Owns the mobile backend origin advertised in pairing links: the Tailscale
 * HTTPS address while Serve exposes this backend, otherwise the local origin.
 * Status/enable/disable keep that origin in sync and record Serve ownership.
 * Each channel only touches its own Serve HTTPS port (`tailscaleServeHttpsPort`).
 */
export function makeDesktopMobileRemoteAccess(input: {
  readonly baseDir: string;
  readonly tailscaleServeHttpsPort: number;
  readonly getBackendPort: () => number;
  readonly getBackendHost: () => string;
  readonly getIsQuitting?: () => boolean;
}) {
  configureMobileGatewayLifecycle(input.getIsQuitting ?? (() => false));
  const targetPort = () => desktopMobileGatewayPort() ?? input.getBackendPort();
  const ownership = createFileServeOwnershipStore(
    Path.join(input.baseDir, SERVE_OWNERSHIP_FILE),
    input.tailscaleServeHttpsPort,
  );
  const detectOwner = createBigbudLockOwnerDetector(bigbudStateRoots());
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
      adopt(
        await getDesktopTailscaleRemoteAccessStatus(
          targetPort(),
          undefined,
          ownership,
          detectOwner,
        ),
      ),
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
            detectOwner,
          ),
        );
      }),
    takeOverTailscaleRemoteAccess: () =>
      runMobileGatewayOwnerOperation(async () =>
        adopt(
          await takeOverDesktopTailscaleRemoteAccess(
            targetPort(),
            undefined,
            ownership,
            assertMobileGatewayOwnerAvailable,
            detectOwner,
          ),
        ),
      ),
    disableTailscaleRemoteAccess: () =>
      runMobileGatewayOwnerOperation(async () => {
        const status = await disableDesktopTailscaleRemoteAccess(
          targetPort(),
          undefined,
          ownership,
          assertMobileGatewayOwnerAvailable,
          detectOwner,
        );
        mobileBackendBaseUrl = desktopMobileGatewayOrigin() ?? localBaseUrl;
        return status;
      }),
  };
}
