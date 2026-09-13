import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMobileDevRegistry, discoverMobileDevUrl } from "@bigbud/shared/DevMobileRegistry";
import { createLogger, type InlineConfig, type ViteDevServer } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { listenMobileDevServer } from "./dev.listener.ts";
import { mobileDevRegistryPlugin } from "./dev.registry.ts";

let root: string;
const servers: ViteDevServer[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bigbud-mobile-discovery-test-"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function start(base: string, host = "127.0.0.1") {
  const registry = await createMobileDevRegistry(root, "0", path.join(root, "registry"));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Missing port");
  const logger = createLogger("silent");
  const warning = vi.spyOn(logger, "warn");
  const config: InlineConfig = {
    configFile: false,
    root,
    base,
    customLogger: logger,
    server: { host, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [mobileDevRegistryPlugin(registry)],
  };
  const server = await listenMobileDevServer(address.port, undefined, config);
  servers.push(server);
  const bound = server.httpServer?.address();
  if (!bound || typeof bound === "string") throw new Error("Missing listener");
  return { registry, port: bound.port, warning };
}

it.each(["/", "/mobile/"])("discovers the supported pairing base %s", async (base) => {
  const { registry, port } = await start(base);
  await expect.poll(() => discoverMobileDevUrl(registry)).toBe(`http://127.0.0.1:${port}`);
});

it("does not advertise an unsupported base whose pairing path would fail", async () => {
  const { registry, port, warning } = await start("/preview/");
  expect(warning).toHaveBeenCalledWith(
    expect.stringContaining("Automatic Local pairing is unavailable"),
  );
  expect(await discoverMobileDevUrl(registry)).toBeNull();
  expect((await fetch(`http://127.0.0.1:${port}/mobile/pair/example`)).status).toBe(404);
});

it("discovers the exact IPv6 origin for an IPv6-only companion", async (context) => {
  let started: Awaited<ReturnType<typeof start>>;
  try {
    started = await start("/", "::1");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(String(error.code))
    ) {
      context.skip();
      return;
    }
    throw error;
  }
  const { registry, port } = started;
  const expectedUrl = `http://[::1]:${port}`;
  await expect.poll(() => discoverMobileDevUrl(registry)).toBe(expectedUrl);
  expect((await fetch(`${expectedUrl}/__bigbud/mobile-dev-health`)).status).toBe(200);
});
