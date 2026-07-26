import type { DesktopCertificateChallenge } from "@bigbud/contracts/server/ipc.desktopCertificate.ts";

import {
  canVisitCertificateChallenge,
  confirmAndResolveCertificateChallenge,
} from "./BrowserPanel.certificateChallenge";
import { BrowserPanelErrorPage } from "./BrowserPanel.errorPage";
import {
  classifyBrowserNavigationError,
  type BrowserLoadFailure,
} from "./BrowserPanel.navigationError";

export function BrowserPanelNavigationErrorPage({
  failure,
  certificateChallenge,
  agentControlled,
  onReload,
  onGoBack,
}: {
  failure: BrowserLoadFailure | null;
  certificateChallenge: DesktopCertificateChallenge | null;
  agentControlled: boolean;
  onReload: () => void;
  onGoBack?: (() => void) | undefined;
}) {
  if (!failure || failure.errorCode === -3) return null;

  const bridge = window.desktopBridge;
  const onVisitAnyway =
    bridge && canVisitCertificateChallenge(certificateChallenge, failure, agentControlled)
      ? () => {
          void confirmAndResolveCertificateChallenge(bridge, certificateChallenge).catch(() => {
            // The pending main-process challenge will still expire safely.
          });
        }
      : undefined;

  return (
    <BrowserPanelErrorPage
      content={classifyBrowserNavigationError(failure)}
      onReload={onReload}
      onGoBack={onGoBack}
      onVisitAnyway={onVisitAnyway}
    />
  );
}
