import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createDevPortCoordinator,
  readDevPortReservations,
} from "@bigbud/shared/DevPortCoordinator";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { mobilePortCoordinationPlugin } from "./dev.coordination.ts";
import { coordinatedTestPort } from "./dev.coordination.test.helpers.ts";
import { resolveMobileDevRepoRoot } from "./dev.identity.ts";
import { listenMobileDevServer } from "./dev.listener.ts";

let root: string;
const servers: ViteDevServer[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bigbud-dev-lifecycle-test-"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await rm(root, { recursive: true, force: true });
});
const config = () => ({
  root,
  configFile: false as const,
  logLevel: "silent" as const,
  server: { host: "127.0.0.1", hmr: false as const, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});

it("does not retain a generation reference when a restart configure post-hook throws", async () => {
  const coordinator = await createDevPortCoordinator(root, path.join(root, "ports"));
  let generation = 0;
  const server = await listenMobileDevServer(
    await coordinatedTestPort(),
    undefined,
    {
      ...config(),
      plugins: [
        {
          name: "failed-generation-post-hook",
          enforce: "post",
          configureServer: {
            order: "post",
            handler(candidate) {
              servers.push(candidate);
              const current = ++generation;
              return () => {
                if (current === 2) throw new Error("fixture restart construction failed");
              };
            },
          },
        },
      ],
    },
    coordinator,
  );
  await server.restart();
  expect(generation).toBe(2);
  expect(server.httpServer?.listening).toBe(true);
  await server.close();
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
});

it("cancels queued listen before closing and cannot reserve or bind after close", async () => {
  const coordinator = await createDevPortCoordinator(root, path.join(root, "ports"));
  const server = await createServer({
    ...config(),
    server: { ...config().server, port: await coordinatedTestPort(), strictPort: true },
    plugins: [mobilePortCoordinationPlugin(coordinator, undefined)],
  });
  servers.push(server);
  await coordinator.withLock(async () => {
    const startup = server.listen();
    const rejected = expect(startup).rejects.toThrow();
    await vi.waitFor(async () =>
      expect(await readdir(path.join(coordinator.directory, "slots"))).toHaveLength(2),
    );
    await server.close();
    await rejected;
    expect(server.httpServer?.listening).toBe(false);
    expect(await readDevPortReservations(coordinator)).toEqual([]);
  });
  await expect(server.listen()).rejects.toThrow("closed during startup");
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
});

it("drains an admitted startup before closing the HTTP listener and releasing its lease", async () => {
  const coordinator = await createDevPortCoordinator(root, path.join(root, "ports"));
  let resume!: () => void;
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const server = await createServer({
    ...config(),
    server: { ...config().server, port: await coordinatedTestPort(), strictPort: true },
    plugins: [
      {
        name: "admitted-build-barrier",
        async buildStart() {
          reached();
          await barrier;
        },
      },
      mobilePortCoordinationPlugin(coordinator, undefined),
    ],
  });
  servers.push(server);
  const startup = server.listen();
  const rejected = expect(startup).rejects.toThrow("closed during startup");
  try {
    await entered;
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resume();
    await closing;
    await rejected;
    expect(server.httpServer?.listening).toBe(false);
    expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
  } finally {
    resume();
    await startup.catch(() => undefined);
  }
});

it("accepts canonical checkout aliases and refuses a stale inherited checkout identity", async () => {
  const alias = path.join(root, "alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  expect(await resolveMobileDevRepoRoot(root, alias)).toBe(
    await resolveMobileDevRepoRoot(root, undefined),
  );
  await expect(resolveMobileDevRepoRoot(root, tmpdir())).rejects.toThrow("does not match");
});
