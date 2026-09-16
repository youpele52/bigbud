import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  createDevPortCoordinator,
  readDevPortReservations,
  reserveDevPort,
} from "@bigbud/shared/DevPortCoordinator";
import { DEFAULT_WEB_PORT } from "@bigbud/shared/DevPorts";

import { isWebDevInformationRequest, webDevStartPort, webDevViteArgs } from "./dev.options.ts";
import { reserveWebDevPort } from "./dev.ports.ts";
import { listenWebDevTestSocket } from "./dev.test.helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function coordinator() {
  const directory = await mkdtemp(path.join(tmpdir(), "bigbud-dev-web-unit-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return createDevPortCoordinator(directory, path.join(directory, "state"));
}

async function occupiedPort(host: string) {
  const server = await listenWebDevTestSocket(host);
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  return address.port;
}

describe("web launcher options", () => {
  it("uses CLI, PORT, then the shared default independently of discovery and user state", () => {
    expect(webDevStartPort([], {})).toBe(DEFAULT_WEB_PORT);
    expect(webDevStartPort([], { PORT: "5900", BIGBUD_DEV_WEB_PORT: "6000" })).toBe(5900);
    expect(webDevStartPort(["--port", "5901", "--port=5902"], { PORT: "bad" })).toBe(5902);
    expect(webDevStartPort(["--", "--port=6000"], { PORT: "5900" })).toBe(5900);
    expect(webDevStartPort([], { BIGBUD_HOME: "/other", T3CODE_HOME: "/elsewhere" })).toBe(
      DEFAULT_WEB_PORT,
    );
  });

  it.each(["0", "65536", "2.5", "bad", ""])("rejects invalid port %j", (value) => {
    expect(() => webDevStartPort([`--port=${value}`], {})).toThrow("between 1 and 65535");
  });

  it("preserves all Vite arguments and forces the final selected port before --", () => {
    const args = [
      "serve",
      "--config",
      "custom.mjs",
      "--mode",
      "staging",
      "--host",
      "::1",
      "--base=/web/",
      "--force",
      "--port=5900",
      "--strictPort=false",
      "--",
      "root",
    ];
    expect(webDevViteArgs(args, 5902)).toEqual([
      ...args.slice(0, -2),
      "--port",
      "5902",
      "--strictPort",
      "--",
      "root",
    ]);
  });

  it.each(["--help", "-h", "--version", "-v"])("bypasses allocation for %s", (arg) => {
    expect(isWebDevInformationRequest(["--config=custom.mjs", arg])).toBe(true);
    expect(isWebDevInformationRequest(["--", arg])).toBe(false);
  });
});

describe("web port allocation", () => {
  it.each(["127.0.0.1", "0.0.0.0", "::1", "::"])(
    "skips real listeners on %s and shared mobile reservations",
    async (host) => {
      const coord = await coordinator();
      const busy = await occupiedPort(host);
      const mobile = await coord.withLock(() => reserveDevPort(coord, busy + 1, "mobile"));
      cleanup.push(mobile.release);
      const lease = await reserveWebDevPort(coord, busy);
      cleanup.push(lease.release);
      expect(lease.reservation.port).toBeGreaterThan(busy + 1);
      expect(lease.reservation.ownerPid).toBe(process.pid);
    },
  );

  it("serializes concurrent selections even before either Vite child binds", async () => {
    const coord = await coordinator();
    const busy = await occupiedPort("127.0.0.1");
    const leases = await Promise.all([
      reserveWebDevPort(coord, busy),
      reserveWebDevPort(coord, busy),
    ]);
    cleanup.push(...leases.map((lease) => lease.release));
    expect(new Set(leases.map((lease) => lease.reservation.port)).size).toBe(2);
  });

  it("attaches the exact runner port even if occupied, and keeps its own lease after release", async () => {
    const coord = await coordinator();
    const port = await occupiedPort("127.0.0.1");
    const parent = await coord.withLock(() => reserveDevPort(coord, port, "web"));
    cleanup.push(parent.release);
    const child = await reserveWebDevPort(coord, port, parent.reservation.token);
    cleanup.push(child.release);
    expect(child.reservation.port).toBe(port);
    expect(child.reservation.parentToken).toBe(parent.reservation.token);
    await parent.release();
    expect(await coord.withLock(() => readDevPortReservations(coord))).toEqual([child.reservation]);
  });

  it("rejects mismatched, mobile, missing and released parent reservations", async () => {
    const coord = await coordinator();
    const parent = await coord.withLock(() => reserveDevPort(coord, 6100, "web"));
    cleanup.push(parent.release);
    await expect(reserveWebDevPort(coord, 6101, parent.reservation.token)).rejects.toThrow("match");
    await expect(reserveWebDevPort(coord, 6100, "missing")).rejects.toThrow("match");
    await parent.release();
    await expect(reserveWebDevPort(coord, 6100, parent.reservation.token)).rejects.toThrow("match");
    const mobile = await coord.withLock(() => reserveDevPort(coord, 6100, "mobile"));
    cleanup.push(mobile.release);
    await expect(reserveWebDevPort(coord, 6100, mobile.reservation.token)).rejects.toThrow("match");
  });

  it("cancels before allocating a lease", async () => {
    const coord = await coordinator();
    await expect(reserveWebDevPort(coord, 6100, undefined, AbortSignal.abort())).rejects.toThrow();
    expect(await coord.withLock(() => readDevPortReservations(coord))).toEqual([]);
  });
});
