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
});
