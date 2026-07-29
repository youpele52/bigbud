import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";
import type { DesktopCertificateChallenge } from "@bigbud/contracts/server/ipc.desktopCertificate.ts";
import type { BrowserLoadFailure } from "./BrowserPanel.navigationError";
import type { ElectronWebview } from "./BrowserPanel.viewport.types";
import {
  certificateChallengeToLoadFailure,
  rejectCertificateChallenge,
  subscribeToCertificateChallenges,
} from "./BrowserPanel.certificateChallenge";

export function makeWebviewCertificateChallengeController(input: {
  bridge: DesktopBridge | undefined;
  webview: ElectronWebview;
  onChallenge: (challenge: DesktopCertificateChallenge | null) => void;
  onFailure: (failure: BrowserLoadFailure) => void;
}): { rejectPending: () => void; unsubscribe: () => void } {
  let pendingChallenge: DesktopCertificateChallenge | null = null;
  const unsubscribe = subscribeToCertificateChallenges(input.bridge, input.webview, (challenge) => {
    pendingChallenge = challenge;
    input.onChallenge(challenge);
    if (challenge) input.onFailure(certificateChallengeToLoadFailure(challenge));
  });

  return {
    rejectPending() {
      const challenge = pendingChallenge;
      if (!challenge || !input.bridge) return;
      void rejectCertificateChallenge(input.bridge, challenge).finally(() => {
        if (pendingChallenge !== challenge) return;
        pendingChallenge = null;
        input.onChallenge(null);
      });
    },
    unsubscribe,
  };
}
