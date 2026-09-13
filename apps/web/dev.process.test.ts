import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it, vi } from "vitest";
import {
  createDevPortCoordinator,
  readDevPortReservations,
  reserveDevPort,
} from "@bigbud/shared/DevPortCoordinator";
import { isDevPortAvailable } from "@bigbud/shared/DevPortAvailability";
import { listenWebDevTestSocket } from "./dev.test.helpers.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const launcher = fileURLToPath(new URL("./dev.ts", import.meta.url));
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "bigbud-dev-web-process-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "vite.config.mjs");
  const state = path.join(directory, "listener.json");
  const watcherReady = path.join(directory, "watcher-ready");
  const source = `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    const stateFile = ${JSON.stringify(state)};
    const watcherReadyFile = ${JSON.stringify(watcherReady)};
    export default {
      server: { host: '127.0.0.1', port: 1, strictPort: false },
      plugins: [{ name: 'test-listener', configureServer(server) {
        const markWatcherReady = () => writeFileSync(watcherReadyFile, 'ready');
        if (server.watcher._readyEmitted) markWatcherReady();
        else server.watcher.once('ready', markWatcherReady);
        server.httpServer.once('listening', () => {
          const previous = existsSync(stateFile)
            ? JSON.parse(readFileSync(stateFile, 'utf8')).generation
            : 0;
          writeFileSync(stateFile,
          JSON.stringify({ pid: process.pid, port: server.httpServer.address().port,
            root: process.env.BIGBUD_DEV_REPO_ROOT, mode: server.config.mode,
            base: server.config.base, envPort: process.env.PORT, generation: Number(previous) + 1 }));
        });
      }}]
    };
  `;
  await writeFile(config, source);
  return { directory, config, state, source, watcherReady };
}

function start(directory: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd: directory,
    env: { ...process.env, BIGBUD_DEV_WEB_RESERVATION: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  return { child, exited, output: () => output };
}

async function readListener(state: string) {
  return JSON.parse(await readFile(state, "utf8")) as {
    pid: number;
    port: number;
    root: string;
    mode: string;
    base: string;
    envPort: string;
    generation: number;
  };
}

async function waitForListener(state: string) {
  await vi.waitFor(async () => expect((await readListener(state)).port).toBeGreaterThan(0), {
    timeout: 15_000,
  });
  return readListener(state);
}

async function freePort() {
  const socket = await listenWebDevTestSocket();
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

async function reservationsFor(child: ChildProcess) {
  const coordinator = await createDevPortCoordinator(repoRoot);
  return coordinator.withLock(async () =>
    (await readDevPortReservations(coordinator)).filter((entry) => entry.ownerPid === child.pid),
  );
}

it("coordinates alternate configs and preserves Vite options and the lease across restart", async () => {
  const files = await fixture();
  const port = await freePort();
  const runner = start(
    files.directory,
    [
      "--config",
      files.config,
      "--configLoader",
      "bundle",
      "--port",
      String(port),
      "--mode",
      "staging",
      "--base",
      "/test/",
      "--strictPort=false",
    ],
    { BIGBUD_DEV_WEB_RESERVATION: undefined, BIGBUD_HOME: files.directory },
  );
  const first = await waitForListener(files.state);
  expect(first.pid).toBe(runner.child.pid);
  expect(first).toMatchObject({
    root: repoRoot.replace(/\/$/, ""),
    mode: "staging",
    base: "/test/",
  });
  expect(first.envPort).toBe(String(first.port));
  const before = await reservationsFor(runner.child);
  expect(before).toHaveLength(1);
  expect(before[0]?.port).toBe(first.port);
  // The mutex must be available while Vite is running.
  await vi.waitFor(async () => expect(await readFile(files.watcherReady, "utf8")).toBe("ready"), {
    timeout: 15_000,
  });
  await writeFile(files.config, `${files.source}\n// restart\n`);
  await vi.waitFor(
    async () => {
      expect((await readListener(files.state)).generation).toBeGreaterThan(first.generation);
    },
    { timeout: 15_000 },
  );
  expect((await readListener(files.state)).port).toBe(first.port);
  expect(await reservationsFor(runner.child)).toEqual(before);
  runner.child.kill("SIGTERM");
  await runner.exited;
  expect(await reservationsFor(runner.child)).toEqual([]);
  expect(await isDevPortAvailable(first.port)).toBe(true);
  expect(() => process.kill(first.pid, 0)).toThrow();
}, 30_000);

it.each(["--help", "--version"])(
  "forwards %s with no allocation or port validation",
  async (flag) => {
    const files = await fixture();
    const runner = start(files.directory, [flag], {
      PORT: "invalid",
      BIGBUD_DEV_WEB_RESERVATION: "bad",
    });
    expect(await runner.exited).toBe(0);
    expect(runner.output()).toMatch(/vite/i);
    expect(await reservationsFor(runner.child)).toEqual([]);
  },
);

it("Vite binds the appended port when the original CLI candidate is occupied", async () => {
  const files = await fixture();
  const socket = await listenWebDevTestSocket();
  cleanup.push(() => new Promise<void>((resolve) => socket.close(() => resolve())));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  const runner = start(
    files.directory,
    [
      "--config",
      files.config,
      "--configLoader",
      "native",
      `--port=${address.port}`,
      "--port",
      String(address.port),
    ],
    { BIGBUD_DEV_WEB_RESERVATION: undefined, PORT: "invalid" },
  );
  const listener = await waitForListener(files.state);
  expect(listener.port).toBeGreaterThan(address.port);
  expect((await reservationsFor(runner.child))[0]?.port).toBe(listener.port);
  runner.child.kill("SIGTERM");
  await runner.exited;
  expect(await isDevPortAvailable(listener.port)).toBe(true);
}, 20_000);

it("attaches a runner lease, rejects a second live wrapper, and survives parent lease release", async () => {
  const files = await fixture();
  const coord = await createDevPortCoordinator(repoRoot);
  const parent = await coord.withLock(async () => {
    const port = await freePort();
    return reserveDevPort(coord, port, "web");
  });
  cleanup.push(parent.release);
  const env = {
    PORT: String(parent.reservation.port),
    BIGBUD_DEV_WEB_RESERVATION: parent.reservation.token,
  };
  const args = ["--config", files.config, "--configLoader", "native"];
  const first = start(files.directory, args, env);
  const listener = await waitForListener(files.state);
  expect(listener.port).toBe(parent.reservation.port);
  const mismatchPort = listener.port === 65535 ? 65534 : listener.port + 1;
  const mismatch = start(files.directory, [...args, "--port", String(mismatchPort)], env);
  expect(await mismatch.exited).toBe(1);
  expect(mismatch.output()).toMatch(/does not match/);
  expect(await reservationsFor(mismatch.child)).toEqual([]);
  const second = start(files.directory, args, env);
  expect(await second.exited).toBe(1);
  expect(second.output()).toMatch(/already reserved/);
  await parent.release();
  const records = await reservationsFor(first.child);
  expect(records).toHaveLength(1);
  expect(records[0]?.parentToken).toBe(parent.reservation.token);
  first.child.kill("SIGINT");
  await first.exited;
  expect(await reservationsFor(first.child)).toEqual([]);
  expect(await isDevPortAvailable(listener.port)).toBe(true);
}, 20_000);

it("fails without shifting when the runner's reserved port has a real listener", async () => {
  const files = await fixture();
  const socket = await listenWebDevTestSocket();
  cleanup.push(() => new Promise<void>((resolve) => socket.close(() => resolve())));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  const coord = await createDevPortCoordinator(repoRoot);
  const parent = await coord.withLock(() => reserveDevPort(coord, address.port, "web"));
  cleanup.push(parent.release);
  const runner = start(files.directory, ["--config", files.config, "--configLoader", "native"], {
    PORT: String(address.port),
    BIGBUD_DEV_WEB_RESERVATION: parent.reservation.token,
  });
  expect(await runner.exited).toBe(1);
  expect(runner.output()).toMatch(/already in use/);
  expect(await reservationsFor(runner.child)).toEqual([]);
  expect(await coord.withLock(() => readDevPortReservations(coord))).toContainEqual(
    parent.reservation,
  );
});

it("releases the lease if Vite fails during startup", async () => {
  const files = await fixture();
  const runner = start(files.directory, ["--config", path.join(files.directory, "missing.mjs")], {
    PORT: String(await freePort()),
    BIGBUD_DEV_WEB_RESERVATION: undefined,
  });
  expect(await runner.exited).toBe(1);
  expect(runner.output()).toMatch(/failed to load config/);
  expect(await reservationsFor(runner.child)).toEqual([]);
});

it.each([false, true])(
  "SIGKILL ends the lease owner and listener (before bind: %s)",
  async (beforeBind) => {
    const files = await fixture();
    const port = await freePort();
    if (beforeBind) {
      await writeFile(
        files.config,
        files.source.replace(
          "export default",
          `
      writeFileSync(${JSON.stringify(files.state)}, JSON.stringify({ pid: process.pid, port: ${port} }));
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      export default
    `,
        ),
      );
    }
    const args = ["--config", files.config, "--configLoader", "native", "--port", String(port)];
    const runner = start(files.directory, args, { BIGBUD_DEV_WEB_RESERVATION: undefined });
    const listener = await waitForListener(files.state);
    expect(listener.pid).toBe(runner.child.pid);
    const leases = await reservationsFor(runner.child);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.ownerPid).toBe(listener.pid);
    expect(await isDevPortAvailable(leases[0]!.port)).toBe(beforeBind);
    runner.child.kill("SIGKILL");
    await runner.exited;
    expect(() => process.kill(listener.pid, 0)).toThrow();
    expect(await reservationsFor(runner.child)).toEqual([]);
    expect(await isDevPortAvailable(leases[0]!.port)).toBe(true);
    await writeFile(files.config, files.source);
    const replacement = start(files.directory, args, { BIGBUD_DEV_WEB_RESERVATION: undefined });
    await vi.waitFor(
      async () => {
        expect((await readListener(files.state)).pid).toBe(replacement.child.pid);
      },
      { timeout: 15_000 },
    );
    expect((await readListener(files.state)).port).toBe(port);
  },
  30_000,
);
