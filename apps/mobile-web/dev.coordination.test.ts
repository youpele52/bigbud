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

import { MobileDevPortUnavailable } from "./dev.coordination.ts";
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

async function mobile(startPort = firstPort) {
  const coordinator = await createDevPortCoordinator(root, storageRoot);
  const registry = await createMobileDevRegistry(root, "0", path.join(root, "registry"));
  const server = await listenMobileDevServer(
    startPort,
    undefined,
    {
      ...config(),
      plugins: [mobileDevRegistryPlugin(registry)],
    },
    coordinator,
  );
  servers.push(server);
  // Publication must be complete when listen returns, not merely scheduled.
  expect(await discoverMobileDevUrl(registry)).toBe(`http://127.0.0.1:${portOf(server)}`);
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
            const selectedWebPort = DEFAULT_WEB_PORT + ports.webOffset;
            expect(selectedWebPort).toBeGreaterThanOrEqual(firstPort);
            // This is the previously unprotected gap: selected web is NOT listening.
            // A separately initialized companion has no sibling env to rely on.
            const companion = await mobile(selectedWebPort);
            expect(portOf(companion.server)).toBeGreaterThan(selectedWebPort);
            const childLease = await reserveWebDevPort(
              coordinator,
              selectedWebPort,
              ports.webReservation,
            );
            try {
              const web = await createServer({
                ...config(),
                server: { ...config().server, port: selectedWebPort },
                plugins: [mobileDiscoveryPlugin(root, companion.registry)],
              });
              servers.push(web);
              await web.listen();
              expect(portOf(web)).toBe(selectedWebPort);
              expect(
                await fetch(`http://127.0.0.1:${selectedWebPort}/__bigbud/mobile-dev`).then((r) =>
                  r.json(),
                ),
              ).toEqual({ url: `http://127.0.0.1:${portOf(companion.server)}` });
              await web.restart();
              expect(portOf(web)).toBe(selectedWebPort);
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
    const companionPort = portOf(companion.server);
    expect(companionPort).toBeGreaterThanOrEqual(firstPort);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ports = yield* reserveRunnerPorts({
            mode,
            startOffset: companionPort - DEFAULT_WEB_PORT,
            hasExplicitServerPort: true,
            hasExplicitDevUrl: false,
            dryRun: false,
            repoRoot: root,
            storageRoot,
          });
          const selectedWebPort = DEFAULT_WEB_PORT + ports.webOffset;
          expect(selectedWebPort).toBeGreaterThan(companionPort);
          yield* Effect.promise(async () => {
            const web = await createServer({
              ...config(),
              server: { ...config().server, port: selectedWebPort },
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
  const initialPort = portOf(companion.server);
  await companion.server.restart();
  expect(portOf(companion.server)).toBe(initialPort);
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
  const companionPort = portOf(companion.server);
  expect(companionPort).toBeGreaterThanOrEqual(firstPort);
  expect(
    (await coordinator.withLock(() => readDevPortReservations(coordinator))).map((r) => r.port),
  ).toContain(companionPort);
});

it("retries an external bind collision after taking the mutex and releases the failed lease", async () => {
  const coordinator = await createDevPortCoordinator(root, storageRoot);
  const registry = await createMobileDevRegistry(root, "0", path.join(root, "registry"));
  const blocker = createHttpServer();
  let first = true;
  let configuredPort: number | undefined;
  let attemptedPort: number | undefined;
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
            configureServer(server) {
              configuredPort = server.config.server.port;
            },
            async buildStart() {
              if (!first) return;
              first = false;
              const candidate = configuredPort;
              if (candidate === undefined) throw new Error("Missing configured candidate");
              attemptedPort = candidate;
              try {
                await new Promise<void>((resolve, reject) => {
                  blocker.once("error", reject);
                  blocker.listen(candidate, "127.0.0.1", resolve);
                });
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  !("code" in error) ||
                  error.code !== "EADDRINUSE"
                ) {
                  throw error;
                }
                throw new MobileDevPortUnavailable(
                  `Mobile development port ${candidate} became unavailable`,
                );
              }
            },
          },
        ],
      },
      coordinator,
    );
    servers.push(server);
    expect(attemptedPort).toBeDefined();
    expect(portOf(server)).toBeGreaterThan(attemptedPort!);
    expect(await discoverMobileDevUrl(registry)).toBe(`http://127.0.0.1:${portOf(server)}`);
    const records = await coordinator.withLock(() => readDevPortReservations(coordinator));
    expect(records.map((r) => r.port)).toEqual([portOf(server)]);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});
