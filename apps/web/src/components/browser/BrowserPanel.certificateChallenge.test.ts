import { describe, expect, it, vi } from "vitest";
import type { DesktopCertificateChallengeEvent } from "@bigbud/contracts/server/ipc.desktopCertificate.ts";

import {
  canVisitCertificateChallenge,
  certificateChallengeToLoadFailure,
  confirmAndResolveCertificateChallenge,
  isLiveCertificateChallengeForFailure,
  rejectCertificateChallenge,
  subscribeToCertificateChallenges,
} from "./BrowserPanel.certificateChallenge";
import { makeWebviewCertificateChallengeController } from "./BrowserPanel.certificateChallenge.webview";

const challenge = {
  challengeId: "challenge-1",
  guestWebContentsId: 42,
  url: "https://africa.h2atlas.de/africa",
  error: "net::ERR_CERT_DATE_INVALID",
};

describe("browser certificate challenge logic", () => {
  it("maps a pending challenge event to a visible matching failure with an eligible action", () => {
    let emit: ((event: DesktopCertificateChallengeEvent) => void) | undefined;
    const onChallenge = vi.fn();
    const onFailure = vi.fn();
    makeWebviewCertificateChallengeController({
      bridge: {
        onCertificateChallenge: (next: (event: DesktopCertificateChallengeEvent) => void) => {
          emit = next;
          return vi.fn();
        },
      } as never,
      webview: { getWebContentsId: () => 42 } as never,
      onChallenge,
      onFailure,
    });

    emit?.({ type: "pending", challenge });
    const failure = certificateChallengeToLoadFailure(challenge);

    expect(onChallenge).toHaveBeenCalledWith(challenge);
    expect(onFailure).toHaveBeenCalledWith({
      errorCode: -1,
      errorDescription: "ERR_CERT_DATE_INVALID",
      validatedURL: challenge.url,
    });
    expect(canVisitCertificateChallenge(challenge, failure, false)).toBe(true);

    emit?.({ type: "cleared", challengeId: challenge.challengeId });
    expect(onChallenge.mock.calls).toEqual([[challenge], [null]]);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("matches only the corresponding certificate load failure", () => {
    expect(
      isLiveCertificateChallengeForFailure(challenge, {
        errorCode: -201,
        errorDescription: "ERR_CERT_DATE_INVALID",
        validatedURL: challenge.url,
      }),
    ).toBe(true);
    expect(
      isLiveCertificateChallengeForFailure(challenge, {
        errorCode: -201,
        errorDescription: "ERR_CERT_DATE_INVALID",
        validatedURL: "https://example.com/",
      }),
    ).toBe(false);
    expect(
      canVisitCertificateChallenge(
        challenge,
        {
          errorCode: -201,
          errorDescription: "ERR_CERT_DATE_INVALID",
          validatedURL: challenge.url,
        },
        true,
      ),
    ).toBe(false);
  });

  it("filters events to the current webview and clears the matching challenge", () => {
    let emit: ((event: DesktopCertificateChallengeEvent) => void) | undefined;
    const listener = vi.fn();
    subscribeToCertificateChallenges(
      {
        onCertificateChallenge: (next: (event: DesktopCertificateChallengeEvent) => void) => {
          emit = next;
          return vi.fn();
        },
      } as never,
      { getWebContentsId: () => 42 } as never,
      listener,
    );

    emit?.({ type: "pending", challenge: { ...challenge, guestWebContentsId: 7 } });
    emit?.({ type: "pending", challenge });
    emit?.({ type: "cleared", challengeId: "other" });
    emit?.({ type: "cleared", challengeId: challenge.challengeId });

    expect(listener.mock.calls).toEqual([[challenge], [null]]);
  });

  it("uses the desktop confirmation and resolves the exact challenge once", async () => {
    const confirm = vi.fn(async () => true);
    const resolveCertificateChallenge = vi.fn(async () => true);

    await expect(
      confirmAndResolveCertificateChallenge({ confirm, resolveCertificateChallenge }, challenge),
    ).resolves.toBe(true);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("only to this navigation"));
    expect(resolveCertificateChallenge).toHaveBeenCalledWith({
      challengeId: "challenge-1",
      guestWebContentsId: 42,
      allow: true,
    });
  });

  it("rejects a superseded pending challenge", async () => {
    const resolveCertificateChallenge = vi.fn(async () => true);

    await rejectCertificateChallenge({ resolveCertificateChallenge }, challenge);

    expect(resolveCertificateChallenge).toHaveBeenCalledWith({
      challengeId: "challenge-1",
      guestWebContentsId: 42,
      allow: false,
    });
  });

  it("keeps a superseded challenge until its rejection is resolved", async () => {
    let emit: ((event: DesktopCertificateChallengeEvent) => void) | undefined;
    let finishResolution: ((value: boolean) => void) | undefined;
    const resolveCertificateChallenge = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishResolution = resolve;
        }),
    );
    const onChallenge = vi.fn();
    const controller = makeWebviewCertificateChallengeController({
      bridge: {
        onCertificateChallenge: (next: (event: DesktopCertificateChallengeEvent) => void) => {
          emit = next;
          return vi.fn();
        },
        resolveCertificateChallenge,
      } as never,
      webview: { getWebContentsId: () => 42 } as never,
      onChallenge,
      onFailure: vi.fn(),
    });
    emit?.({ type: "pending", challenge });

    controller.rejectPending();
    expect(resolveCertificateChallenge).toHaveBeenCalledWith({
      challengeId: "challenge-1",
      guestWebContentsId: 42,
      allow: false,
    });
    expect(onChallenge).toHaveBeenCalledTimes(1);

    finishResolution?.(true);
    await vi.waitFor(() => expect(onChallenge).toHaveBeenLastCalledWith(null));
  });
});
