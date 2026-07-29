import { randomUUID } from "node:crypto";
import type { App, Event, WebContents } from "electron";
import type {
  DesktopCertificateChallenge,
  DesktopCertificateChallengeEvent,
  DesktopCertificateChallengeResolution,
} from "@bigbud/contracts/server/ipc.desktopCertificate.ts";
import { CERTIFICATE_CHALLENGE_EVENT_CHANNEL } from "./certificateChallenge.channels";

const CERTIFICATE_CHALLENGE_TIMEOUT_MS = 60_000;

interface PendingCertificateChallenge {
  challenge: DesktopCertificateChallenge;
  hostWebContents: WebContents;
  callback: (isTrusted: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface CertificateErrorEvent extends Event {
  preventDefault(): void;
}

export interface CertificateChallengeManager {
  attachGuest(hostWebContents: WebContents, guestWebContents: WebContents): void;
  handleCertificateError(
    event: CertificateErrorEvent,
    webContents: WebContents,
    url: string,
    error: string,
    callback: (isTrusted: boolean) => void,
    isMainFrame: boolean,
  ): void;
  resolve(sender: WebContents, resolution: DesktopCertificateChallengeResolution): boolean;
  closeHost(hostWebContents: WebContents): void;
}

export function registerCertificateErrorHandler(
  app: App,
  manager: CertificateChallengeManager,
): void {
  app.on(
    "certificate-error",
    (event, webContents, url, error, _certificate, callback, isMainFrame) => {
      manager.handleCertificateError(event, webContents, url, error, callback, isMainFrame);
    },
  );
}

export function makeCertificateChallengeManager(input?: {
  timeoutMs?: number;
  generateId?: () => string;
}): CertificateChallengeManager {
  const timeoutMs = input?.timeoutMs ?? CERTIFICATE_CHALLENGE_TIMEOUT_MS;
  const generateId = input?.generateId ?? randomUUID;
  const guests = new Map<number, { hostWebContents: WebContents; guestWebContents: WebContents }>();
  const pendingByGuestId = new Map<number, PendingCertificateChallenge>();

  const send = (hostWebContents: WebContents, event: DesktopCertificateChallengeEvent): void => {
    if (!hostWebContents.isDestroyed()) {
      hostWebContents.send(CERTIFICATE_CHALLENGE_EVENT_CHANNEL, event);
    }
  };

  const clear = (pending: PendingCertificateChallenge, allow: boolean): void => {
    if (pendingByGuestId.get(pending.challenge.guestWebContentsId) !== pending) return;
    pendingByGuestId.delete(pending.challenge.guestWebContentsId);
    clearTimeout(pending.timeout);
    send(pending.hostWebContents, {
      type: "cleared",
      challengeId: pending.challenge.challengeId,
    });
    pending.callback(allow);
  };

  const rejectGuest = (guestWebContentsId: number): void => {
    const pending = pendingByGuestId.get(guestWebContentsId);
    if (pending) clear(pending, false);
  };

  return {
    attachGuest(hostWebContents, guestWebContents) {
      rejectGuest(guestWebContents.id);
      guests.set(guestWebContents.id, { hostWebContents, guestWebContents });
      guestWebContents.once("destroyed", () => {
        if (guests.get(guestWebContents.id)?.guestWebContents !== guestWebContents) return;
        rejectGuest(guestWebContents.id);
        guests.delete(guestWebContents.id);
      });
    },

    handleCertificateError(event, webContents, url, error, callback, isMainFrame) {
      const guest = guests.get(webContents.id);
      if (!guest || guest.guestWebContents !== webContents || !isMainFrame) {
        callback(false);
        return;
      }

      event.preventDefault();
      rejectGuest(webContents.id);

      const challenge: DesktopCertificateChallenge = {
        challengeId: generateId(),
        guestWebContentsId: webContents.id,
        url,
        error,
      };
      const pending: PendingCertificateChallenge = {
        challenge,
        hostWebContents: guest.hostWebContents,
        callback,
        timeout: setTimeout(() => rejectGuest(webContents.id), timeoutMs),
      };
      pendingByGuestId.set(webContents.id, pending);
      send(guest.hostWebContents, { type: "pending", challenge });
    },

    resolve(sender, resolution) {
      const pending = pendingByGuestId.get(resolution.guestWebContentsId);
      if (
        !pending ||
        pending.hostWebContents !== sender ||
        pending.challenge.challengeId !== resolution.challengeId
      ) {
        return false;
      }

      clear(pending, resolution.allow);
      return true;
    },

    closeHost(hostWebContents) {
      for (const pending of pendingByGuestId.values()) {
        if (pending.hostWebContents === hostWebContents) clear(pending, false);
      }
      for (const [guestId, guest] of guests) {
        if (guest.hostWebContents === hostWebContents) guests.delete(guestId);
      }
    },
  };
}

export const certificateChallengeManager = makeCertificateChallengeManager();
