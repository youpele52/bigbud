import { describe, expect, it, vi } from "vitest";

import {
  disableDesktopTailscaleRemoteAccess,
  enableDesktopTailscaleRemoteAccess,
  takeOverDesktopTailscaleRemoteAccess,
} from "./tailscaleRemoteAccess";
import type { ServeOwnershipStore } from "./tailscaleRemoteAccess.ownership";
import type { LoopbackOwnerDetector } from "./tailscaleRemoteAccess.takeover";

const HOST = "desk.tail1.ts.net";
const STABLE = { "/": { Proxy: "http://127.0.0.1:3773" } };

/**
 * A fake `tailscale` CLI holding a live multi-listener config. Mutations apply
 * `--https=<port>` semantics: set "/" on that listener, or turn that listener off.
 */
function fakeTailscale(initial: Record<number, Record<string, unknown>>) {
  const listeners = new Map(Object.entries(initial).map(([port, h]) => [Number(port), h]));
  const run = vi.fn(async (_binary: string, args: readonly string[]) => {
    if (args[0] === "status") {
      const self = { DNSName: `${HOST}.`, Online: true };
      return { stdout: JSON.stringify({ BackendState: "Running", Self: self }), stderr: "" };
    }
    if (args[1] === "status") {
      const web = Object.fromEntries(
        [...listeners].map(([port, handlers]) => [`${HOST}:${port}`, { Handlers: handlers }]),
      );
      return { stdout: JSON.stringify({ Web: web }), stderr: "" };
    }
    const port = Number(args.find((arg) => arg.startsWith("--https="))?.slice(8));
    if (args.at(-1) === "off") listeners.delete(port);
    else listeners.set(port, { ...listeners.get(port), "/": { Proxy: args.at(-1) } });
    return { stdout: "", stderr: "" };
  });
  return { run, listeners, mutations: () => run.mock.calls.filter(([, a]) => a[1] === "--yes") };
}

function memoryOwnership(httpsPort: number, port: number | null = null) {
  const store: ServeOwnershipStore & { port: number | null } = {
    httpsPort,
    port,
    read: () => store.port,
    write: (next) => {
      store.port = next;
    },
    clear: () => {
      store.port = null;
    },
  };
  return store;
}

const bigbudAt =
  (port: number, label = "bigbud"): LoopbackOwnerDetector =>
  async (candidate) =>
    candidate === port ? { label } : null;

describe("per-channel Tailscale Serve ports", () => {
  it("enables beta on 8443 while stable's 443 handler stays untouched", async () => {
    const cli = fakeTailscale({ 443: STABLE });
    const ownership = memoryOwnership(8443);

    const status = await enableDesktopTailscaleRemoteAccess(3774, cli.run, ownership);

    expect(cli.mutations().map(([, args]) => args)).toEqual([
      ["serve", "--yes", "--bg", "--https=8443", "http://127.0.0.1:3774"],
    ]);
    expect(cli.listeners.get(443)).toEqual(STABLE);
    expect(status).toMatchObject({ serving: true, remoteBaseUrl: `https://${HOST}:8443` });
    expect(ownership.port).toBe(3774);
  });

  it("disables dev's 10000 listener without touching stable or beta", async () => {
    const beta = { "/": { Proxy: "http://127.0.0.1:3774" } };
    const cli = fakeTailscale({
      443: STABLE,
      8443: beta,
      10000: { "/": { Proxy: "http://127.0.0.1:3775" } },
    });
    const ownership = memoryOwnership(10000, 3775);

    await disableDesktopTailscaleRemoteAccess(3775, cli.run, ownership);

    expect(cli.mutations().map(([, args]) => args)).toEqual([
      ["serve", "--yes", "--https=10000", "off"],
    ]);
    expect(cli.listeners.get(443)).toEqual(STABLE);
    expect(cli.listeners.get(8443)).toEqual(beta);
    expect(ownership.port).toBeNull();
  });

  it("reports another bigbud on this channel's port with a take-over offer, changing nothing", async () => {
    const cli = fakeTailscale({ 443: { "/": { Proxy: "http://127.0.0.1:3774" } } });
    const ownership = memoryOwnership(443);

    const status = await enableDesktopTailscaleRemoteAccess(
      3773,
      cli.run,
      ownership,
      undefined,
      undefined,
      bigbudAt(3774, "bigbud beta"),
    );

    expect(status).toMatchObject({
      serving: false,
      conflict: { loopbackPort: 3774, bigbudOwnerLabel: "bigbud beta", canTakeOver: true },
    });
    expect(status.error).toContain("looks like bigbud beta");
    expect(cli.mutations()).toEqual([]);
    expect(ownership.port).toBeNull();
  });

  it("takes over only this channel's handler when it belongs to another bigbud", async () => {
    const grafana = { "/": { Proxy: "http://127.0.0.1:3000" } };
    const cli = fakeTailscale({ 443: { "/": { Proxy: "http://127.0.0.1:3774" } }, 9000: grafana });
    const ownership = memoryOwnership(443);

    const status = await takeOverDesktopTailscaleRemoteAccess(
      3773,
      cli.run,
      ownership,
      undefined,
      bigbudAt(3774),
    );

    expect(cli.mutations().map(([, args]) => args)).toEqual([
      ["serve", "--yes", "--bg", "--https=443", "http://127.0.0.1:3773"],
    ]);
    expect(cli.listeners.get(9000)).toEqual(grafana);
    expect(status).toMatchObject({
      serving: true,
      conflict: null,
      remoteBaseUrl: `https://${HOST}`,
    });
    expect(ownership.port).toBe(3773);
  });

  it("never takes over a handler that is not another bigbud", async () => {
    const cli = fakeTailscale({ 443: { "/": { Proxy: "http://127.0.0.1:3000" } } });
    const ownership = memoryOwnership(443);

    const status = await takeOverDesktopTailscaleRemoteAccess(
      3773,
      cli.run,
      ownership,
      undefined,
      bigbudAt(3774),
    );

    expect(cli.mutations()).toEqual([]);
    expect(status).toMatchObject({ serving: false, conflict: { canTakeOver: false } });
    expect(ownership.port).toBeNull();
  });

  it("rechecks the owner gate after detection before taking over", async () => {
    const cli = fakeTailscale({ 443: { "/": { Proxy: "http://127.0.0.1:3774" } } });
    const guard = vi.fn(() => {
      throw new Error("owner yielded");
    });

    await expect(
      takeOverDesktopTailscaleRemoteAccess(
        3773,
        cli.run,
        memoryOwnership(443),
        guard,
        bigbudAt(3774),
      ),
    ).rejects.toThrow("owner yielded");
    expect(cli.mutations()).toEqual([]);
  });
});
