import { describe, expect, it } from "vitest";

import { resolveBackendReachNotice } from "./MobileRemoteControlSettingsSection.status";

const HOSTED = "https://mobile.bigbud.app";

describe("resolveBackendReachNotice", () => {
  it("labels LAN pairing addresses as same-network only and notes mixed content", () => {
    const notice = resolveBackendReachNotice({
      backendBaseUrl: "http://192.168.1.20:3773",
      mobileWebBaseUrl: HOSTED,
    });
    expect(notice?.tone).toBe("warning");
    expect(notice?.message).toContain("Same-network only");
    expect(notice?.message).toContain("browsers block this HTTP address");
  });

  it("omits the mixed-content note for an HTTP mobile page in development", () => {
    const notice = resolveBackendReachNotice({
      backendBaseUrl: "http://192.168.1.20:3773",
      mobileWebBaseUrl: "http://192.168.1.20:5740",
    });
    expect(notice?.message).not.toContain("browsers block");
  });

  it("labels private-network HTTPS as same-network only", () => {
    expect(
      resolveBackendReachNotice({
        backendBaseUrl: "https://box.local:8443",
        mobileWebBaseUrl: HOSTED,
      })?.message,
    ).toContain("Same-network only");
  });

  it("warns that loopback addresses cannot be reached from a phone", () => {
    expect(
      resolveBackendReachNotice({ backendBaseUrl: "http://127.0.0.1:3773", mobileWebBaseUrl: null })
        ?.message,
    ).toContain("only works on this computer");
  });

  it("states the phone Tailscale prerequisite for tailnet HTTPS without warning", () => {
    expect(
      resolveBackendReachNotice({
        backendBaseUrl: "https://desktop.tail1.ts.net",
        mobileWebBaseUrl: HOSTED,
      }),
    ).toEqual({
      tone: "info",
      message:
        "Designed for use from other networks: the phone needs Tailscale signed in and connected, and your tailnet must allow it to reach this computer.",
    });
  });

  it("returns nothing for unknown HTTPS hosts or invalid input", () => {
    expect(
      resolveBackendReachNotice({
        backendBaseUrl: "https://bigbud.example.com",
        mobileWebBaseUrl: HOSTED,
      }),
    ).toBeNull();
    expect(resolveBackendReachNotice({ backendBaseUrl: "", mobileWebBaseUrl: HOSTED })).toBeNull();
  });
});
