export interface DesktopCertificateChallenge {
  challengeId: string;
  guestWebContentsId: number;
  url: string;
  error: string;
}

export type DesktopCertificateChallengeEvent =
  | { type: "pending"; challenge: DesktopCertificateChallenge }
  | { type: "cleared"; challengeId: string };

export interface DesktopCertificateChallengeResolution {
  challengeId: string;
  guestWebContentsId: number;
  allow: boolean;
}

export interface DesktopCertificateChallengeBridge {
  onCertificateChallenge: (
    listener: (event: DesktopCertificateChallengeEvent) => void,
  ) => () => void;
  resolveCertificateChallenge: (
    resolution: DesktopCertificateChallengeResolution,
  ) => Promise<boolean>;
}
