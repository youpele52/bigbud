import { describe, expect, it } from "vitest";

import { resolveTailscaleRemoteBackendCheck } from "./MobileRemoteControlSettingsSection.status";

describe("resolveTailscaleRemoteBackendCheck", () => {
  it("returns checking while the backend check is still running", () => {
    expect(
      resolveTailscaleRemoteBackendCheck({
        isLoading: true,
        status: null,
        isMutating: false,
      }),
    ).toEqual({
      status: "checking",
      message: "Checking Tailscale remote access.",
      tip: "bigbud is still checking whether this desktop backend is reachable through Tailscale Serve.",
    });
  });

  it("returns verified when Serve is exposing the backend", () => {
    expect(
      resolveTailscaleRemoteBackendCheck({
        isLoading: false,
        status: {
          installed: true,
          running: true,
          online: true,
          serving: true,
          remoteBaseUrl: "https://example.ts.net",
          httpsPort: 443,
          conflict: null,
          error: null,
        },
        isMutating: false,
      }),
    ).toEqual({
      status: "verified",
      message: "Remote backend available at https://example.ts.net.",
      tip: null,
    });
  });

  it("returns error with a fix tip when the daemon is not running", () => {
    expect(
      resolveTailscaleRemoteBackendCheck({
        isLoading: false,
        status: {
          installed: true,
          running: false,
          online: false,
          serving: false,
          remoteBaseUrl: null,
          httpsPort: 443,
          conflict: null,
          error: "Tailscale is installed but the daemon is not running.",
        },
        isMutating: false,
      }),
    ).toEqual({
      status: "error",
      message: "Tailscale is installed but the daemon is not running.",
      tip: "Start the Tailscale daemon on this machine, then try again.",
    });
  });

  it("separates a bigbud take-over tip from a foreign-service refusal tip", () => {
    const base = {
      installed: true,
      running: true,
      online: true,
      serving: false,
      remoteBaseUrl: "https://example.ts.net:8443",
      httpsPort: 8443,
      error: "taken",
    };
    const bigbud = resolveTailscaleRemoteBackendCheck({
      isLoading: false,
      isMutating: false,
      status: {
        ...base,
        conflict: { loopbackPort: 3773, bigbudOwnerLabel: "bigbud", canTakeOver: true },
      },
    });
    expect(bigbud.tip).toContain("Take over");
    const foreign = resolveTailscaleRemoteBackendCheck({
      isLoading: false,
      isMutating: false,
      status: {
        ...base,
        conflict: { loopbackPort: 3000, bigbudOwnerLabel: null, canTakeOver: false },
      },
    });
    expect(foreign.tip).toContain("HTTPS port 8443 yourself");
    expect(foreign.tip).not.toContain("Take over");
  });
});
