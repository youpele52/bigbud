import type { DesktopTailscaleRemoteAccessStatus } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { resolveTailscaleTakeOverOffer } from "./MobileRemoteControlSettingsSection.takeover.logic";

const conflicted: DesktopTailscaleRemoteAccessStatus = {
  installed: true,
  running: true,
  online: true,
  serving: false,
  remoteBaseUrl: "https://desk.tail123.ts.net",
  httpsPort: 443,
  conflict: { loopbackPort: 3773, bigbudOwnerLabel: "bigbud", canTakeOver: true },
  error: "taken",
};

describe("resolveTailscaleTakeOverOffer", () => {
  it("offers take over for another bigbud and names what stops working", () => {
    const offer = resolveTailscaleTakeOverOffer(conflicted);
    expect(offer?.description).toContain("https://desk.tail123.ts.net");
    expect(offer?.description).toContain("bigbud (127.0.0.1:3773)");
    expect(offer?.confirmMessage).toContain(
      "Other Tailscale Serve routes and ports are not changed",
    );
  });

  it.each([
    ["a foreign service", { loopbackPort: 3000, bigbudOwnerLabel: null, canTakeOver: false }],
    ["a non-proxy handler", { loopbackPort: null, bigbudOwnerLabel: null, canTakeOver: false }],
    ["no conflict", null],
  ] as const)("offers nothing for %s", (_label, conflict) => {
    expect(resolveTailscaleTakeOverOffer({ ...conflicted, conflict })).toBeNull();
  });

  it("offers nothing once this app is serving or before status loads", () => {
    expect(resolveTailscaleTakeOverOffer({ ...conflicted, serving: true })).toBeNull();
    expect(resolveTailscaleTakeOverOffer(null)).toBeNull();
  });
});
