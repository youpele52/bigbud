import { describe, expect, it } from "vitest";
import {
  allowsMobileCredentialOrigin,
  mobileHostNavigationURL,
  resolveMobileDeploymentPolicy,
} from "./mobileDeploymentPolicy";

describe("mobile per-origin credential deployment contract", () => {
  it("keeps host-served A credentials at A and uses a clean top-level link for B", () => {
    const policy = resolveMobileDeploymentPolicy("https://a.invalid");
    expect(allowsMobileCredentialOrigin(policy, "https://a.invalid")).toBe(true);
    expect(allowsMobileCredentialOrigin(policy, "https://b.invalid")).toBe(false);
    expect(mobileHostNavigationURL("https://b.invalid")).toBe("https://b.invalid/mobile/");
    expect(mobileHostNavigationURL("https://b.invalid?token=fixture")).toBeNull();
    expect(mobileHostNavigationURL("https://b.invalid#secret=fixture")).toBeNull();
  });
  it("permits multi-host credentials only on the exact approved hosted compatibility origin", () => {
    const policy = resolveMobileDeploymentPolicy("https://mobile.bigbud.app");
    expect(allowsMobileCredentialOrigin(policy, "https://a.invalid")).toBe(true);
    expect(allowsMobileCredentialOrigin(policy, "https://b.invalid")).toBe(true);
    for (const value of [
      "http://mobile.bigbud.app",
      "https://mobile.bigbud.app:444",
      "https://sub.mobile.bigbud.app",
      "https://mobile.bigbud.app.attacker.invalid",
    ]) {
      expect(resolveMobileDeploymentPolicy(value).hostedCompatibility).toBe(false);
    }
  });
  it("requires explicit development plus exact loopback fixture origin and never enables production overrides", () => {
    const fixture = "http://127.0.0.1:15749";
    expect(resolveMobileDeploymentPolicy(fixture, { development: true }).hostedCompatibility).toBe(
      false,
    );
    expect(
      resolveMobileDeploymentPolicy(fixture, { development: false, hostedFixtureOrigin: fixture })
        .hostedCompatibility,
    ).toBe(false);
    expect(
      resolveMobileDeploymentPolicy(fixture, { development: true, hostedFixtureOrigin: fixture })
        .hostedCompatibility,
    ).toBe(true);
    expect(
      resolveMobileDeploymentPolicy("https://a.invalid", {
        development: true,
        hostedFixtureOrigin: "https://a.invalid",
      }).hostedCompatibility,
    ).toBe(false);
    expect(
      resolveMobileDeploymentPolicy("http://127.0.0.1:15750", {
        development: true,
        hostedFixtureOrigin: fixture,
      }).hostedCompatibility,
    ).toBe(false);
  });
  it("retains same-origin legacy HTTP/LAN without treating it as cross-host compatibility", () => {
    const policy = resolveMobileDeploymentPolicy("http://192.168.1.10:3000");
    expect(allowsMobileCredentialOrigin(policy, "http://192.168.1.10:3000")).toBe(true);
    expect(allowsMobileCredentialOrigin(policy, "http://192.168.1.11:3000")).toBe(false);
    expect(mobileHostNavigationURL("http://192.168.1.10:3000")).toBeNull();
  });
  it("never accepts credential-bearing URLs or missing application origin", () => {
    const policy = resolveMobileDeploymentPolicy("https://mobile.bigbud.app");
    for (const value of [
      "https://user:password@a.invalid",
      "https://a.invalid/path",
      "https://a.invalid?token=fixture",
      "file:///tmp/fixture",
    ])
      expect(allowsMobileCredentialOrigin(policy, value)).toBe(false);
    expect(
      allowsMobileCredentialOrigin(resolveMobileDeploymentPolicy(""), "https://a.invalid"),
    ).toBe(false);
  });
});
