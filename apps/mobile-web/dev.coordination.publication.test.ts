import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createDevPortCoordinator,
  readDevPortReservations,
} from "@bigbud/shared/DevPortCoordinator";
import * as Registry from "@bigbud/shared/DevMobileRegistry";
import type { ViteDevServer } from "vite";
import { expect, it, vi } from "vitest";

import { listenMobileDevServer } from "./dev.listener.ts";
import { mobileDevRegistryPlugin } from "./dev.registry.ts";
import { coordinatedTestPort } from "./dev.coordination.test.helpers.ts";

it("does not unlock mobile admission until actual listener publication completes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bigbud-dev-publication-test-"));
  const coordinator = await createDevPortCoordinator(root, path.join(root, "ports"));
  const registry = await Registry.createMobileDevRegistry(root, "0", path.join(root, "registry"));
  const port = await coordinatedTestPort();
  let allowPublication!: () => void;
  const publicationBarrier = new Promise<void>((resolve) => {
    allowPublication = resolve;
  });
  let publicationReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    publicationReached = resolve;
  });
  const publish = Registry.publishMobileDevRecord;
  const spy = vi.spyOn(Registry, "publishMobileDevRecord").mockImplementation(async (...args) => {
    publicationReached();
    await publicationBarrier;
    return publish(...args);
  });
  let server: ViteDevServer | undefined;
  let admitted = false;
  let contender: Promise<unknown> | undefined;
  const starting = listenMobileDevServer(
    port,
    undefined,
    {
      root,
      configFile: false,
      logLevel: "silent",
      server: { host: "127.0.0.1", hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [mobileDevRegistryPlugin(registry)],
    },
    coordinator,
  ).then((value) => {
    server = value;
    return value;
  });
  try {
    await Promise.race([reached, starting]);
    contender = coordinator.withLock(async () => {
      admitted = true;
      return readDevPortReservations(coordinator);
    });
    // Observe the contender's doorway slot, not an arbitrary delay: it really
    // has begun acquisition while the listening mobile server is publishing.
    await vi.waitFor(async () =>
      expect(await readdir(path.join(coordinator.directory, "slots"))).toHaveLength(2),
    );
    expect(admitted).toBe(false);
    allowPublication();
    await starting;
    const address = server?.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No bound server");
    await contender;
    expect(admitted).toBe(true);
    expect(await Registry.discoverMobileDevUrl(registry)).toBe(`http://127.0.0.1:${address.port}`);
  } finally {
    allowPublication();
    await starting;
    await contender;
    spy.mockRestore();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
