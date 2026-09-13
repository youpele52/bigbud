import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMobileDevRegistry, discoverMobileDevUrl } from "@bigbud/shared/DevMobileRegistry";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";

import { mobileDiscoveryPlugin } from "../web/src/dev/mobileDiscoveryPlugin";
import { listenMobileDevServer } from "./dev.listener.ts";
import { mobileDevRegistryPlugin } from "./dev.registry.ts";

it("binds concurrent companions independently and lets a later web server discover them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bigbud-mobile-concurrent-test-"));
  const blocker = createHttpServer();
  const servers: ViteDevServer[] = [];
  try {
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("Missing blocker address");
    const registryRoot = path.join(root, "registry");
    const registry = await createMobileDevRegistry(root, "0", registryRoot);
    const config = {
      root,
      configFile: false as const,
      logLevel: "silent" as const,
      server: { host: "127.0.0.1", hmr: false as const, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    };
    const starts = await Promise.allSettled(
      [0, 1].map(async () => {
        const server = await listenMobileDevServer(address.port, undefined, {
          ...config,
          plugins: [mobileDevRegistryPlugin(registry)],
        });
        servers.push(server);
        const bound = server.httpServer?.address();
        if (!bound || typeof bound === "string") throw new Error("Missing mobile address");
        return bound.port;
      }),
    );
    const ports = starts.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    expect(new Set(ports).size).toBe(2);
    expect(ports.every((port) => port > address.port)).toBe(true);
    const expectedUrl = `http://127.0.0.1:${Math.min(...ports)}`;
    await expect.poll(() => discoverMobileDevUrl(registry)).toBe(expectedUrl);

    // A separately initialized web instance shares only the on-disk identity.
    const webRegistry = await createMobileDevRegistry(root, "0", registryRoot);
    const web = await createServer({
      ...config,
      plugins: [mobileDiscoveryPlugin(root, webRegistry)],
      server: { ...config.server, port: 0 },
    });
    servers.push(web);
    await web.listen();
    const webAddress = web.httpServer?.address();
    if (!webAddress || typeof webAddress === "string") throw new Error("Missing web address");
    const endpoint = `http://127.0.0.1:${webAddress.port}/__bigbud/mobile-dev`;
    expect(await fetch(endpoint).then((response) => response.json())).toEqual({ url: expectedUrl });

    for (const server of servers) {
      const bound = server.httpServer?.address();
      if (bound && typeof bound !== "string" && bound.port === Math.min(...ports)) {
        await server.close();
      }
    }
    await expect
      .poll(() => fetch(endpoint).then((response) => response.json()))
      .toEqual({ url: `http://127.0.0.1:${Math.max(...ports)}` });
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
