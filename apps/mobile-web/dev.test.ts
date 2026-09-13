import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer as createHttpServer, get, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createMobileDevRegistry,
  discoverMobileDevUrl,
  type MobileDevRegistry,
} from "@bigbud/shared/DevMobileRegistry";
import {
  MOBILE_DEV_DISCOVERY_PATH,
  MOBILE_DEV_HEALTH_PATH,
} from "@bigbud/shared/DevMobileRegistry.http";
import { createServer, type InlineConfig, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mobileDiscoveryPlugin } from "../web/src/dev/mobileDiscoveryPlugin";
import { listenMobileDevServer, parseMobileDevPort } from "./dev.listener.ts";
import { mobileDevRegistryPlugin } from "./dev.registry.ts";

let root: string;
let registry: MobileDevRegistry;
const viteServers: ViteDevServer[] = [];
const blockers: Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bigbud-mobile-vite-test-"));
  registry = await createMobileDevRegistry(root, "0", path.join(root, "registry"));
});

afterEach(async () => {
  await Promise.all(viteServers.splice(0).map((server) => server.close()));
  await Promise.all(
    blockers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await rm(root, { recursive: true, force: true });
});

function config(): InlineConfig {
  return {
    configFile: false,
    root,
    logLevel: "silent",
    server: { host: "127.0.0.1", hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [mobileDevRegistryPlugin(registry)],
  };
}

function portOf(server: Pick<Server, "address">): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  return address.port;
}

async function block(port = 0, host = "127.0.0.1"): Promise<Server> {
  const server = createHttpServer((_req, res) => res.end("occupied"));
  blockers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

async function start(port: number, sibling?: number, options = config()) {
  const server = await listenMobileDevServer(port, sibling, options);
  viteServers.push(server);
  if (!server.httpServer) throw new Error("Missing Vite listener");
  return { server, port: portOf(server.httpServer) };
}

describe("mobile Vite development listener", () => {
  it("retries a real occupied bind and skips the sibling web port on retry", async () => {
    const occupied = await block();
    const requested = portOf(occupied);
    const { server, port } = await start(requested, requested + 1);
    expect(port).toBeGreaterThan(requested + 1);
    expect(server.config.server.strictPort).toBe(true);
    await expect.poll(() => discoverMobileDevUrl(registry)).toBe(`http://127.0.0.1:${port}`);
  });

  it("handles occupation after Vite creation and skips a sibling at the initial port", async () => {
    const initial = await block();
    const requested = portOf(initial);
    let first = true;
    let attemptedPort: number | undefined;
    const options = config();
    options.plugins?.push({
      name: "claim-after-server-creation",
      async configureServer(server) {
        if (!first) return;
        first = false;
        attemptedPort = server.config.server.port;
        const blocker = await block(0, "127.0.0.1");
        server.config.server.port = portOf(blocker);
      },
    });
    const { port } = await start(requested, requested, options);
    expect(attemptedPort).toBeDefined();
    expect(port).toBeGreaterThan(attemptedPort!);
    await expect.poll(() => discoverMobileDevUrl(registry)).toBe(`http://127.0.0.1:${port}`);
  });

  it("fails non-address startup errors and closes the failed Vite server", async () => {
    let starts = 0;
    let closes = 0;
    const options = config();
    options.plugins?.push({
      name: "startup-failure",
      buildStart() {
        starts++;
        throw Object.assign(new Error("denied startup"), { code: "EACCES" });
      },
      closeBundle() {
        closes++;
      },
    });
    await expect(listenMobileDevServer(5740, undefined, options)).rejects.toThrow("denied startup");
    expect(starts).toBe(1);
    expect(closes).toBeGreaterThan(0);
    expect(await discoverMobileDevUrl(registry)).toBeNull();
  });

  it("tears down watchers and retry observers across repeated occupied wildcard binds", async () => {
    const occupied = await block();
    const requested = portOf(occupied);
    const attempts: ViteDevServer[] = [];
    let firstAttemptedPort: number | undefined;
    const options = config();
    options.server = { host: "0.0.0.0", hmr: false, watch: {} };
    options.plugins?.push({
      name: "repeated-occupation",
      async configureServer(server) {
        attempts.push(server);
        if (attempts.length > 3 || server.config.server.port === requested) return;
        const candidate = server.config.server.port;
        if (firstAttemptedPort === undefined) firstAttemptedPort = candidate;
        const blocker = await block(0, "0.0.0.0");
        server.config.server.port = portOf(blocker);
      },
    });
    const { server, port } = await start(requested, undefined, options);
    expect(firstAttemptedPort).toBeDefined();
    expect(port).toBeGreaterThan(firstAttemptedPort!);
    expect(attempts.length).toBeGreaterThanOrEqual(4);
    for (const attempt of attempts.slice(0, -1)) {
      expect(attempt.httpServer?.listening).toBe(false);
      expect(attempt.watcher.getWatched()).toEqual({});
      expect(
        attempt.httpServer?.listeners("error").some((listener) => listener.name === "onError"),
      ).toBe(false);
    }
    expect(server.httpServer?.listenerCount("listening")).toBeLessThan(5);
  });

  it("fails cleanly at the port ceiling and rejects malformed ports", async () => {
    await expect(listenMobileDevServer(65535, 65535, config())).rejects.toThrow("65535");
    try {
      await block(65535);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE")
        throw error;
    }
    await expect(listenMobileDevServer(65535, undefined, config())).rejects.toThrow("65535");
    expect(parseMobileDevPort(undefined, 5740)).toBe(5740);
    for (const value of ["", "0", "65536", "1.5", "invalid"]) {
      expect(() => parseMobileDevPort(value, 5740)).toThrow("between 1 and 65535");
    }
  });

  it("republishes a new nonce on Vite restart and removes only the closed listener", async () => {
    const occupied = await block();
    const first = await start(portOf(occupied));
    const second = await start(first.port);
    await expect.poll(async () => (await readdir(registry.directory)).length).toBe(2);
    const before = await fetch(`http://127.0.0.1:${first.port}${MOBILE_DEV_HEALTH_PATH}`).then(
      (res) => res.json(),
    );
    await first.server.restart();
    await expect.poll(async () => (await readdir(registry.directory)).length).toBe(2);
    const after = await fetch(`http://127.0.0.1:${first.port}${MOBILE_DEV_HEALTH_PATH}`).then(
      (res) => res.json(),
    );
    expect(after).not.toEqual(before);
    await first.server.close();
    expect(await readdir(registry.directory)).toHaveLength(1);
    await expect.poll(() => discoverMobileDevUrl(registry)).toBe(`http://127.0.0.1:${second.port}`);
  });

  it("serves live no-store discovery and rejects remote origins and hostnames", async () => {
    const web = await createServer({
      ...config(),
      plugins: [mobileDiscoveryPlugin(root, registry)],
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    });
    viteServers.push(web);
    await web.listen();
    const endpoint = `http://127.0.0.1:${portOf(web.httpServer!)}${MOBILE_DEV_DISCOVERY_PATH}`;
    const empty = await fetch(endpoint);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.json()).toEqual({ url: null });
    const occupied = await block();
    const mobile = await start(portOf(occupied));
    await expect
      .poll(() => fetch(endpoint).then((res) => res.json()))
      .toEqual({ url: `http://127.0.0.1:${mobile.port}` });
    expect((await fetch(endpoint, { headers: { Origin: "https://remote.invalid" } })).status).toBe(
      403,
    );
    const remoteHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(endpoint, { headers: { Host: "remote.invalid" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
    expect(remoteHostStatus).toBe(403);
    expect((await fetch(endpoint, { method: "POST" })).status).toBe(403);
    await mobile.server.close();
    await expect.poll(() => fetch(endpoint).then((res) => res.json())).toEqual({ url: null });
  });
});
