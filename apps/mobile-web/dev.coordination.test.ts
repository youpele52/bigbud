import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createDevPortCoordinator,
  readDevPortReservations,
} from "@bigbud/shared/DevPortCoordinator";
import { createMobileDevRegistry, discoverMobileDevUrl } from "@bigbud/shared/DevMobileRegistry";
import { DEFAULT_WEB_PORT } from "@bigbud/shared/DevPorts";
import { Effect } from "effect";
import { createServer, type InlineConfig, type ViteDevServer } from "vite";
import { afterEach, beforeEach, expect, it } from "vitest";

import { listenMobileDevServer } from "./dev.listener.ts";
import { mobileDevRegistryPlugin } from "./dev.registry.ts";
import { reserveWebDevPort } from "../web/dev.ports.ts";
import { mobileDiscoveryPlugin } from "../web/src/dev/mobileDiscoveryPlugin.ts";
import { reserveRunnerPorts } from "../../scripts/dev-runner.coordination.ts";
import { DevRunnerError } from "../../scripts/dev-runner.lib.ts";
import { coordinatedTestPort } from "./dev.coordination.test.helpers.ts";

let root: string;
let storageRoot: string;
let firstPort: number;
const servers: ViteDevServer[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bigbud-dev-coordination-test-"));
  storageRoot = path.join(root, "ports");
  firstPort = await coordinatedTestPort();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await rm(root, { recursive: true, force: true });
});

function config(): InlineConfig {
  return {
    configFile: false,
    root,
    logLevel: "silent",
    server: { host: "127.0.0.1", hmr: false, watch: null, strictPort: true },
    optimizeDeps: { noDiscovery: true, include: [] },
  };
}

function portOf(server: ViteDevServer): number {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("No bound server");
  return address.port;
}

async function mobile() {
  const coordinator = await createDevPortCoordinator(root, storageRoot);
  const registry = await createMobileDevRegistry(root, "0", path.join(root, "registry"));
  const server = await listenMobileDevServer(
    firstPort,
    undefined,
    {
      ...config(),
      plugins: [mobileDevRegistryPlugin(registry)],
    },
    coordinator,
  );
  servers.push(server);
  // Bounded polling verifies the published discovery record is healthy before returning.
  const expectedUrl = `http://127.0.0.1:${portOf(server)}`;
  await expect.poll(() => discoverMobileDevUrl(registry), { timeout: 5_000 }).toBe(expectedUrl);
  return { server, registry };
}

for (const mode of ["dev:web", "dev:desktop", "dev"] as const) {
  it(`${mode} reserves the web candidate before a separate mobile launch can bind it`, async () => {
    const coordinator = await createDevPortCoordinator(root, storageRoot);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ports = yield* reserveRunnerPorts({
            mode,
            startOffset: firstPort - DEFAULT_WEB_PORT,
            hasExplicitServerPort: true,
            hasExplicitDevUrl: false,
            dryRun: false,
            repoRoot: root,
            storageRoot,
          });
          yield* Effect.promise(async () => {
            expect(DEFAULT_WEB_PORT + ports.webOffset).toBe(firstPort);
            // This is the previously unprotected gap: selected web is NOT listening.
            // A separately initialized companion has no sibling env to rely on.
            const companion = await mobile();
            expect(portOf(companion.server)).toBeGreaterThan(firstPort);
            const childLease = await reserveWebDevPort(
              coordinator,
              firstPort,
              ports.webReservation,
            );
            try {
              const web = await createServer({
                ...config(),
                server: { ...config().server, port: firstPort },
                plugins: [mobileDiscoveryPlugin(root, companion.registry)],
              });
              servers.push(web);
              await web.listen();
              expect(portOf(web)).toBe(firstPort);
              expect(
                await fetch(`http://127.0.0.1:${firstPort}/__bigbud/mobile-dev`).then((r) =>
                  r.json(),
                ),
              ).toEqual({ url: `http://127.0.0.1:${portOf(companion.server)}` });
              await web.restart();
              expect(portOf(web)).toBe(firstPort);
              await web.close();
            } finally {
              await childLease.release();
            }
          });
        }),
      ),
    );
    const remaining = await coordinator.withLock(() => readDevPortReservations(coordinator));
    expect(remaining.every((r) => r.kind === "mobile")).toBe(true);
  });

  it(`${mode} selects another web port when standalone mobile binds first`, async () => {
    const companion = await mobile();
    expect(portOf(companion.server)).toBe(firstPort);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ports = yield* reserveRunnerPorts({
            mode,
            startOffset: firstPort - DEFAULT_WEB_PORT,
            hasExplicitServerPort: true,
            hasExplicitDevUrl: false,
            dryRun: false,
            repoRoot: root,
            storageRoot,
          });
          expect(DEFAULT_WEB_PORT + ports.webOffset).toBeGreaterThan(firstPort);
          yield* Effect.promise(async () => {
            const web = await createServer({
              ...config(),
              server: { ...config().server, port: DEFAULT_WEB_PORT + ports.webOffset },
            });
            servers.push(web);
            await web.listen();
            await web.close();
          });
        }),
      ),
    );
  });
}

it("releases a runner reservation when startup fails and leaves dry-run unreserved", async () => {
  const coordinator = await createDevPortCoordinator(root, storageRoot);
  const input = {
    mode: "dev:web" as const,
    startOffset: firstPort - DEFAULT_WEB_PORT,
    hasExplicitServerPort: false,
    hasExplicitDevUrl: false,
    dryRun: false,
    repoRoot: root,
    storageRoot,
  };
  await expect(
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* reserveRunnerPorts(input);
          return yield* new DevRunnerError({ message: "simulated Turbo failure" });
        }),
      ),
    ),
  ).rejects.toThrow("simulated Turbo failure");
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
  const dry = await Effect.runPromise(
    Effect.scoped(reserveRunnerPorts({ ...input, dryRun: true })),
  );
  expect(dry.webReservation).toBeUndefined();
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
});

it("keeps the mobile port reserved across Vite generations and releases it on final close", async () => {
  const companion = await mobile();
  const coordinator = await createDevPortCoordinator(root, storageRoot);
  const reservationBefore = await coordinator.withLock(() => readDevPortReservations(coordinator));
  await companion.server.restart();
  expect(portOf(companion.server)).toBe(firstPort);
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual(
    reservationBefore,
  );
  await companion.server.close();
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
});

it("releases both the mobile lease and mutex after a fatal listen failure", async () => {
  const coordinator = await createDevPortCoordinator(root, storageRoot);
  await expect(
    listenMobileDevServer(
      firstPort,
      undefined,
      {
        ...config(),
        plugins: [
          {
            name: "fatal-coordinated-start",
            buildStart() {
              throw Object.assign(new Error("denied fixture startup"), { code: "EACCES" });
            },
          },
        ],
      },
      coordinator,
    ),
  ).rejects.toThrow("denied fixture startup");
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
  const companion = await mobile();
  expect(portOf(companion.server)).toBe(firstPort);
});

it("retries an external bind collision after taking the mutex and releases the failed lease", async () => {
  const coordinator = await createDevPortCoordinator(root, storageRoot);
  const registry = await createMobileDevRegistry(root, "0", path.join(root, "registry"));
  const blocker = createHttpServer();
  let first = true;
  try {
    const server = await listenMobileDevServer(
      firstPort,
      undefined,
      {
        ...config(),
        plugins: [
          mobileDevRegistryPlugin(registry),
          {
            name: "external-bind-after-coordinated-probe",
            async buildStart() {
              if (!first) return;
              first = false;
              await new Promise<void>((resolve, reject) => {
                blocker.once("error", reject);
                blocker.listen(firstPort, "127.0.0.1", resolve);
              });
            },
          },
        ],
      },
      coordinator,
    );
    servers.push(server);
    expect(portOf(server)).toBeGreaterThan(firstPort);
    const expectedUrl = `http://127.0.0.1:${portOf(server)}`;
    await expect.poll(() => discoverMobileDevUrl(registry), { timeout: 5_000 }).toBe(expectedUrl);
    const records = await coordinator.withLock(() => readDevPortReservations(coordinator));
    expect(records.map((r) => r.port)).toEqual([portOf(server)]);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});
