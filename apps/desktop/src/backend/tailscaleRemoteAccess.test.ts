import { describe, expect, it, vi } from "vitest";

import {
  disableDesktopTailscaleRemoteAccess,
  enableDesktopTailscaleRemoteAccess,
  getDesktopTailscaleRemoteAccessStatus,
} from "./tailscaleRemoteAccess";

describe("tailscaleRemoteAccess", () => {
  it("reports a ready tailnet URL when serve proxies the current backend port", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "bigbud-dev.tail123.ts.net.", Online: true },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          TCP: {
            "443": {
              HTTPS: true,
            },
          },
          Web: {
            "bigbud-dev.tail123.ts.net:443": {
              Handlers: {
                "/": {
                  Proxy: "http://127.0.0.1:3774",
                },
              },
            },
          },
        }),
        stderr: "",
      });

    await expect(getDesktopTailscaleRemoteAccessStatus(3774, execFile)).resolves.toEqual({
      installed: true,
      running: true,
      online: true,
      serving: true,
      remoteBaseUrl: "https://bigbud-dev.tail123.ts.net",
      error: null,
    });
  });

  it("accepts serve targets that include a trailing slash", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "bigbud-dev.tail123.ts.net.", Online: true },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          Web: {
            "bigbud-dev.tail123.ts.net:443": {
              Handlers: {
                "/": {
                  Proxy: "http://127.0.0.1:3774/",
                },
              },
            },
          },
        }),
        stderr: "",
      });

    await expect(getDesktopTailscaleRemoteAccessStatus(3774, execFile)).resolves.toMatchObject({
      serving: true,
      remoteBaseUrl: "https://bigbud-dev.tail123.ts.net",
      error: null,
    });
  });

  it("rejects serve targets for a different backend port", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "bigbud-dev.tail123.ts.net.", Online: true },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          Web: {
            "bigbud-dev.tail123.ts.net:443": {
              Handlers: {
                "/": {
                  Proxy: "http://127.0.0.1:4888",
                },
              },
            },
          },
        }),
        stderr: "",
      });

    await expect(getDesktopTailscaleRemoteAccessStatus(3774, execFile)).resolves.toMatchObject({
      serving: false,
      error: "Tailscale Serve is not exposing this desktop backend.",
    });
  });

  it("reports missing CLI cleanly", async () => {
    const execFile = vi.fn().mockRejectedValueOnce(new Error("spawn tailscale ENOENT"));

    await expect(getDesktopTailscaleRemoteAccessStatus(3774, execFile)).resolves.toEqual({
      installed: false,
      running: false,
      online: false,
      serving: false,
      remoteBaseUrl: null,
      error: "Tailscale CLI is not installed.",
    });
  });

  it("reports a running but offline tailnet separately from a stopped daemon", async () => {
    const execFile = vi.fn().mockResolvedValueOnce({
      stdout: JSON.stringify({
        BackendState: "Running",
        Self: {
          DNSName: "bigbud-dev.tail123.ts.net.",
          Online: false,
        },
      }),
      stderr: "",
    });

    await expect(getDesktopTailscaleRemoteAccessStatus(3774, execFile)).resolves.toEqual({
      installed: true,
      running: true,
      online: false,
      serving: false,
      remoteBaseUrl: "https://bigbud-dev.tail123.ts.net",
      error: "Tailscale is running but this device is offline.",
    });
  });

  it("enables serve against the loopback backend target", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "bigbud-dev.tail123.ts.net.", Online: true },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          Web: {
            "bigbud-dev.tail123.ts.net:443": {
              Handlers: {
                "/": {
                  Proxy: "http://127.0.0.1:3774",
                },
              },
            },
          },
        }),
        stderr: "",
      });

    const status = await enableDesktopTailscaleRemoteAccess(3774, execFile);

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "tailscale",
      ["serve", "--yes", "--bg", "http://127.0.0.1:3774"],
      expect.objectContaining({ encoding: "utf8", windowsHide: true }),
    );
    expect(status.serving).toBe(true);
  });

  it("disables serve from the default https listener", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "bigbud-dev.tail123.ts.net.", Online: true },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({}),
        stderr: "",
      });

    const status = await disableDesktopTailscaleRemoteAccess(3774, execFile);

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "tailscale",
      ["serve", "--yes", "--https=443", "off"],
      expect.objectContaining({ encoding: "utf8", windowsHide: true }),
    );
    expect(status.serving).toBe(false);
  });
});
