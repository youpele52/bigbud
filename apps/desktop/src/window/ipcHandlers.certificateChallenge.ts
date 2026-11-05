import { app } from "electron";
import type { DesktopCertificateChallengeResolution } from "@bigbud/contracts/server/ipc.desktopCertificate.ts";
import {
  certificateChallengeManager,
  type CertificateChallengeManager,
  registerCertificateErrorHandler,
} from "./certificateChallengeManager";
import { RESOLVE_CERTIFICATE_CHALLENGE_CHANNEL } from "./certificateChallenge.channels";
import { authorizedHandle, BROAD_RENDERER_ROLES } from "./ipcAuthorization";

function getSafeResolution(raw: unknown): DesktopCertificateChallengeResolution | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    typeof value.challengeId !== "string" ||
    value.challengeId.length === 0 ||
    value.challengeId.length > 128 ||
    !Number.isSafeInteger(value.guestWebContentsId) ||
    (value.guestWebContentsId as number) <= 0 ||
    typeof value.allow !== "boolean"
  ) {
    return null;
  }
  return {
    challengeId: value.challengeId,
    guestWebContentsId: value.guestWebContentsId as number,
    allow: value.allow,
  };
}

export function registerCertificateChallengeIpcHandler(manager: CertificateChallengeManager): void {
  authorizedHandle(
    RESOLVE_CERTIFICATE_CHALLENGE_CHANNEL,
    BROAD_RENDERER_ROLES,
    (event, raw: unknown) => {
      const resolution = getSafeResolution(raw);
      return resolution ? manager.resolve(event.sender, resolution) : false;
    },
  );
}

let certificateErrorHandlerRegistered = false;

export function registerCertificateChallengeHandlers(): void {
  if (!certificateErrorHandlerRegistered) {
    registerCertificateErrorHandler(app, certificateChallengeManager);
    certificateErrorHandlerRegistered = true;
  }
  registerCertificateChallengeIpcHandler(certificateChallengeManager);
}
