import { describe, expect, it } from "vitest";

import { initialMobileRecoveryState } from "../../logic/mobileRecovery.types";
import { resolveMobileConnectionNotice } from "./MobileConnectionNotice.logic";

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
});
