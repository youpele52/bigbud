import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";
import type { DesktopCertificateChallenge } from "@bigbud/contracts/server/ipc.desktopCertificate.ts";
import type { BrowserLoadFailure } from "./BrowserPanel.navigationError";
import type { ElectronWebview } from "./BrowserPanel.viewport.types";

function normalizeCertificateError(error: string): string {
  return error.startsWith("net::") ? error.slice(5) : error;
}

export function certificateChallengeToLoadFailure(
  challenge: DesktopCertificateChallenge,
): BrowserLoadFailure {
  return {
    errorCode: -1,
    errorDescription: normalizeCertificateError(challenge.error),
    validatedURL: challenge.url,
  };
}

export function isLiveCertificateChallengeForFailure(
  challenge: DesktopCertificateChallenge | null,
  failure: BrowserLoadFailure | null,
): challenge is DesktopCertificateChallenge {
  return Boolean(
    challenge &&
    failure &&
    challenge.url === failure.validatedURL &&
    normalizeCertificateError(challenge.error) === failure.errorDescription,
  );
}

export function canVisitCertificateChallenge(
  challenge: DesktopCertificateChallenge | null,
  failure: BrowserLoadFailure | null,
  agentControlled: boolean,
): challenge is DesktopCertificateChallenge {
  return !agentControlled && isLiveCertificateChallengeForFailure(challenge, failure);
}

export function subscribeToCertificateChallenges(
  bridge: DesktopBridge | undefined,
  webview: ElectronWebview,
  listener: (challenge: DesktopCertificateChallenge | null) => void,
): () => void {
  if (!bridge) return () => undefined;
  let currentChallengeId: string | null = null;
  return bridge.onCertificateChallenge((event) => {
    if (event.type === "pending") {
      try {
        if (event.challenge.guestWebContentsId !== webview.getWebContentsId()) return;
      } catch {
        return;
      }
      currentChallengeId = event.challenge.challengeId;
      listener(event.challenge);
      return;
    }
    if (event.challengeId !== currentChallengeId) return;
    currentChallengeId = null;
    listener(null);
  });
}

export async function confirmAndResolveCertificateChallenge(
  bridge: Pick<DesktopBridge, "confirm" | "resolveCertificateChallenge">,
  challenge: DesktopCertificateChallenge,
): Promise<boolean> {
  let allow = false;
  try {
    const hostname = new URL(challenge.url).hostname;
    allow = await bridge.confirm(
      `Visit ${hostname} anyway?\n\nThe site's certificate could not be verified. Continuing may expose information you send or receive. This approval applies only to this navigation.`,
    );
  } catch {
    allow = false;
  }
  return bridge.resolveCertificateChallenge({
    challengeId: challenge.challengeId,
    guestWebContentsId: challenge.guestWebContentsId,
    allow,
  });
}

export function rejectCertificateChallenge(
  bridge: Pick<DesktopBridge, "resolveCertificateChallenge">,
  challenge: DesktopCertificateChallenge,
): Promise<boolean> {
  return bridge.resolveCertificateChallenge({
    challengeId: challenge.challengeId,
    guestWebContentsId: challenge.guestWebContentsId,
    allow: false,
  });
}
