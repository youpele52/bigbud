import { describe, expect, it } from "vitest";

import { initialMobileConnectionState } from "../../logic/mobileConnection.logic";
import { initialMobileRecoveryState } from "../../logic/mobileRecovery.types";
import {
  resolveMobileConnectionNotice,
  resolveMobileConnectionPresentation,
} from "./MobileConnectionNotice.logic";

describe("resolveMobileConnectionNotice", () => {
  it("keeps healthy connection presentation quiet", () => {
    expect(resolveMobileConnectionNotice(initialMobileRecoveryState("current"))).toBeNull();
  });

  it("distinguishes stale data from an unavailable connection", () => {
    expect(
      resolveMobileConnectionNotice({
        ...initialMobileRecoveryState("stale"),
        reason: "gap",
      })?.title,
    ).toBe("Showing last-known data");
    expect(
      resolveMobileConnectionNotice({
        ...initialMobileRecoveryState("unavailable"),
        reason: "timeout",
      })?.title,
    ).toBe("Unable to connect");
  });

  it("explains refreshing and legacy limitations without claiming failure", () => {
    expect(resolveMobileConnectionNotice(initialMobileRecoveryState("refreshing"))?.title).toBe(
      "Refreshing chats",
    );
    expect(resolveMobileConnectionNotice(initialMobileRecoveryState("legacy"))?.title).toBe(
      "Live recovery markers unavailable",
    );
  });

  it("prioritizes authorization and exhaustion over transport details", () => {
    const recoveryState = initialMobileRecoveryState("current");
    expect(
      resolveMobileConnectionPresentation({
        recoveryState,
        connection: {
          ...initialMobileConnectionState(),
          authorization: "explicitly-rejected",
          transport: "closed",
        },
      }),
    ).toMatchObject({ title: "Pairing required", actionsDisabled: true, showRetry: false });
    expect(
      resolveMobileConnectionPresentation({
        recoveryState,
        connection: {
          ...initialMobileConnectionState(),
          transport: "exhausted",
          incidentLevel: "escalated",
        },
      }),
    ).toMatchObject({ title: "Unable to connect", actionsDisabled: true, showRetry: true });
  });

  it("keeps short reconnects quiet and escalates at the matrix boundaries", () => {
    const recoveryState = initialMobileRecoveryState("current");
    const base = initialMobileConnectionState();
    expect(
      resolveMobileConnectionPresentation({
        recoveryState,
        connection: { ...base, transport: "connecting", incidentLevel: "short" },
      }),
    ).toBeNull();
    expect(
      resolveMobileConnectionPresentation({
        recoveryState,
        connection: { ...base, transport: "retrying", incidentLevel: "reconnecting" },
      }),
    ).toMatchObject({ title: "Reconnecting", actionsDisabled: true, showRetry: false });
    expect(
      resolveMobileConnectionPresentation({
        recoveryState,
        connection: { ...base, transport: "exhausted", incidentLevel: "escalated" },
      }),
    ).toMatchObject({ title: "Unable to connect", showRetry: true });
  });

  it("describes cached freshness and offline advisory state without false revocation", () => {
    expect(
      resolveMobileConnectionPresentation({
        recoveryState: { ...initialMobileRecoveryState("stale"), lastRefreshedAt: 1 },
        connection: { ...initialMobileConnectionState(), transport: "open" },
      }),
    ).toMatchObject({ title: "Showing last-known data", tone: "warning" });
    expect(
      resolveMobileConnectionPresentation({
        recoveryState: initialMobileRecoveryState("current"),
        connection: {
          ...initialMobileConnectionState(),
          browserOffline: true,
          transport: "closed",
        },
      }),
    ).toMatchObject({ title: "Device is offline", tone: "warning" });
  });
});
