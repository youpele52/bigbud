import { describe, expect, it, vi } from "vitest";

import {
  disableDesktopTailscaleRemoteAccess,
  enableDesktopTailscaleRemoteAccess,
} from "./tailscaleRemoteAccess";
import type { ServeOwnershipStore } from "./tailscaleRemoteAccess.ownership";

const HOST = "bigbud-dev.tail123.ts.net";

function serveConfig(handlers: Record<string, unknown>, listener = `${HOST}:443`) {
  return {
    stdout: JSON.stringify({ Web: { [listener]: { Handlers: handlers } } }),
    stderr: "",
  };
}

const onlineStatus = {
  stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: `${HOST}.`, Online: true } }),
  stderr: "",
};

function memoryOwnership(initial: number | null): ServeOwnershipStore & { port: number | null } {
  const store = {
    port: initial,
    read: () => store.port,
    write: (port: number) => {
      store.port = port;
    },
    clear: () => {
      store.port = null;
    },
  };
  return store;
}

function commandsRun(execFile: ReturnType<typeof vi.fn>): string[][] {
  return execFile.mock.calls.map((call) => call[1] as string[]);
}

describe("tailscaleRemoteAccess mutations only touch Serve configuration bigbud owns", () => {
  it("re-points the stale mapping bigbud recorded and records the new port", async () => {
    const ownership = memoryOwnership(3773);
    const execFile = vi
      .fn()
      .mockResolvedValueOnce(serveConfig({ "/": { Proxy: "http://127.0.0.1:3773" } }))
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce(onlineStatus)
      .mockResolvedValueOnce(serveConfig({ "/": { Proxy: "http://127.0.0.1:3774" } }));

    const status = await enableDesktopTailscaleRemoteAccess(3774, execFile, ownership);

    expect(commandsRun(execFile)[1]).toEqual(["serve", "--yes", "--bg", "http://127.0.0.1:3774"]);
    expect(status).toMatchObject({ serving: true, error: null });
    expect(ownership.port).toBe(3774);
  });

  it("never suggests turning off all of HTTPS 443", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce(serveConfig({ "/": { Proxy: "http://127.0.0.1:3000" } }));
    const error = await enableDesktopTailscaleRemoteAccess(3774, execFile).catch(
      (caught) => caught,
    );
    expect(String(error)).not.toContain("443 off");
  });

  it("refuses to replace an unrecorded loopback service and explains the manual step", async () => {
    const ownership = memoryOwnership(3773);
    const execFile = vi
      .fn()
      .mockResolvedValueOnce(serveConfig({ "/": { Proxy: "http://127.0.0.1:3000" } }));

    await expect(enableDesktopTailscaleRemoteAccess(3774, execFile, ownership)).rejects.toThrow(
      'forwards "/" to 127.0.0.1:3000, which bigbud did not set up, so bigbud left it unchanged',
    );
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(ownership.port).toBe(3773);
  });

  it("does not rewrite Serve when it already exposes this backend, but records ownership", async () => {
    const ownership = memoryOwnership(null);
    const execFile = vi
      .fn()
      .mockResolvedValueOnce(serveConfig({ "/": { Proxy: "http://127.0.0.1:3774" } }))
      .mockResolvedValueOnce(onlineStatus)
      .mockResolvedValueOnce(serveConfig({ "/": { Proxy: "http://127.0.0.1:3774" } }));

    await expect(
      enableDesktopTailscaleRemoteAccess(3774, execFile, ownership),
    ).resolves.toMatchObject({ serving: true });
    expect(commandsRun(execFile).some((args) => args.includes("--bg"))).toBe(false);
    expect(ownership.port).toBe(3774);
  });

  it.each([
    ["a non-loopback proxy", { Proxy: "http://192.168.1.20:8080" }],
    ["a unix socket proxy", { Proxy: "unix:/tmp/other.sock" }],
    ["a static path handler", { Path: "/srv/www" }],
  ])("refuses to replace %s on HTTPS 443", async (_label, handler) => {
    const execFile = vi.fn().mockResolvedValueOnce(serveConfig({ "/": handler }));

    await expect(enableDesktopTailscaleRemoteAccess(3774, execFile)).rejects.toThrow(
      "used by another service",
    );
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("refuses to wipe HTTPS 443 when other routes share it", async () => {
    const execFile = vi.fn().mockResolvedValueOnce(
      serveConfig({
        "/": { Proxy: "http://127.0.0.1:3774" },
        "/grafana": { Proxy: "http://127.0.0.1:3000" },
      }),
    );

    await expect(disableDesktopTailscaleRemoteAccess(3774, execFile)).rejects.toThrow(
      "other routes on this device (/grafana on port 443 → http://127.0.0.1:3000)",
    );
    expect(commandsRun(execFile).some((args) => args.includes("off"))).toBe(false);
  });

  it("removes a stale mapping bigbud recorded and clears the record", async () => {
    const ownership = memoryOwnership(3773);
    const execFile = vi
      .fn()
      .mockResolvedValueOnce(serveConfig({ "/": { Proxy: "http://127.0.0.1:3773" } }))
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce(onlineStatus)
      .mockResolvedValueOnce({ stdout: JSON.stringify({}), stderr: "" });

    const status = await disableDesktopTailscaleRemoteAccess(3774, execFile, ownership);

    expect(commandsRun(execFile)[1]).toEqual(["serve", "--yes", "--https=443", "off"]);
    expect(status.serving).toBe(false);
    expect(ownership.port).toBeNull();
  });

  it("leaves Serve untouched when it maps a service bigbud does not own", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce(serveConfig({ "/": { Proxy: "http://127.0.0.1:9000" } }))
      .mockResolvedValueOnce(onlineStatus)
      .mockResolvedValueOnce(serveConfig({ "/": { Proxy: "http://127.0.0.1:9000" } }));

    const status = await disableDesktopTailscaleRemoteAccess(3774, execFile);

    expect(commandsRun(execFile).some((args) => args.includes("off"))).toBe(false);
    expect(status.serving).toBe(false);
  });

  it("does not treat bigbud's handler on another HTTPS port as removable via 443", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce(
        serveConfig({ "/": { Proxy: "http://127.0.0.1:3774" } }, `${HOST}:8443`),
      );

    await disableDesktopTailscaleRemoteAccess(3774, execFile);

    expect(commandsRun(execFile).some((args) => args.includes("off"))).toBe(false);
  });

  it("refuses to enable when 443 / is foreign even if another listener points at the backend", async () => {
    const ownership = memoryOwnership(null);
    const execFile = vi.fn().mockResolvedValueOnce({
      stdout: JSON.stringify({
        Web: {
          [`${HOST}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3774" } } },
          [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } },
        },
      }),
      stderr: "",
    });

    // Pairing links address https://<host>/, which the other service answers.
    await expect(enableDesktopTailscaleRemoteAccess(3774, execFile, ownership)).rejects.toThrow(
      "127.0.0.1:8080",
    );
    expect(commandsRun(execFile)).toEqual([["serve", "status", "--json"]]);
    expect(ownership.port).toBeNull();
  });

  it("bounds every Tailscale CLI call with a timeout", async () => {
    const execFile = vi.fn().mockResolvedValueOnce(serveConfig({}));

    await disableDesktopTailscaleRemoteAccess(3774, execFile);

    for (const call of execFile.mock.calls) {
      expect(call[2]).toMatchObject({ timeout: expect.any(Number) });
    }
  });
});

it.each(["enable", "disable"] as const)(
  "rechecks ownership after an awaited status read before %s mutates Serve",
  async (action) => {
    let resolve!: (value: ReturnType<typeof serveConfig>) => void;
    const read = new Promise<ReturnType<typeof serveConfig>>((done) => {
      resolve = done;
    });
    const run = vi.fn(() => read);
    const ownership = memoryOwnership(3773);
    let available = true;
    const guard = () => {
      if (!available) throw new Error("owner yielded");
    };
    const pending =
      action === "enable"
        ? enableDesktopTailscaleRemoteAccess(3774, run, ownership, undefined, guard)
        : disableDesktopTailscaleRemoteAccess(3773, run, ownership, guard);
    available = false;
    resolve(serveConfig({ "/": { Proxy: "http://127.0.0.1:3773" } }));
    await expect(pending).rejects.toThrow("owner yielded");
    expect(commandsRun(run)).toEqual([["serve", "status", "--json"]]);
    expect(ownership.port).toBe(3773);
  },
);
