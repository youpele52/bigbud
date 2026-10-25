#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  createConnectionSmokeFixture,
  sanitizeConnectionSmokeError,
} from "./connection-smoke.fixture.mjs";

// Playwright protocol debug output can include authenticated WebSocket URLs.
// These changes affect only this smoke-runner process, not the invoking shell.
delete process.env.DEBUG;
delete process.env.PWDEBUG;
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { _electron: electron } = requireWeb("playwright");
const executeFile = promisify(execFile);

function readOptions() {
  const [executable, flag, rawDuration, ...rest] = process.argv.slice(2);
  const durationMs = rawDuration === undefined ? 12 * 60_000 : Number(rawDuration);
  if (
    !executable ||
    (flag !== undefined && flag !== "--duration-ms") ||
    (flag !== undefined && rawDuration === undefined) ||
    rest.length > 0 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 30_000
  ) {
    throw new Error(
      "Usage: node apps/desktop/scripts/connection-smoke.mjs <packaged-executable> [--duration-ms <milliseconds>=30000]",
    );
  }
  return { executable: resolve(executable), durationMs };
}

/** Observes only frame metadata; never retains configuration values or socket URLs. */
function instrumentWebSockets() {
  const NativeWebSocket = globalThis.WebSocket;
  const sockets = new Set();
  const stats = {
    opened: 0,
    closed: 0,
    configRequests: 0,
    configSnapshots: 0,
    configFailures: 0,
    defects: 0,
  };
  class ObservedWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      const requests = new Map();
      sockets.add(this);
      this.addEventListener("open", () => {
        stats.opened += 1;
      });
      this.addEventListener("close", () => {
        stats.closed += 1;
        requests.clear();
        sockets.delete(this);
      });
      this.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        const requestId = String(frame.requestId);
        if (frame._tag === "Defect") stats.defects += 1;
        if (requests.get(requestId) !== "subscribeServerConfig") return;
        if (frame._tag === "Chunk" && Array.isArray(frame.values)) {
          for (const value of frame.values) {
            if (value?.type === "snapshot" || value?.type === "snapshot\n") {
              stats.configSnapshots += 1;
            }
          }
        }
        if (frame._tag === "Exit") {
          if (frame.exit?._tag === "Failure") stats.configFailures += 1;
          requests.delete(requestId);
        }
      });
      const nativeSend = this.send;
      this.send = (data) => {
        if (typeof data === "string") {
          try {
            const frame = JSON.parse(data);
            if (frame._tag === "Request") {
              const requestId = String(frame.id);
              requests.set(requestId, frame.tag);
              if (requests.size > 256) requests.delete(requests.keys().next().value);
              if (frame.tag === "subscribeServerConfig") stats.configRequests += 1;
            }
            if (frame._tag === "Interrupt") requests.delete(String(frame.requestId));
          } catch {
            // The smoke observer must not change production transport behavior.
          }
        }
        return nativeSend.call(this, data);
      };
    }
  }
  globalThis.WebSocket = ObservedWebSocket;
  Reflect.set(globalThis, "__bigbudConnectionSmoke", {
    stats,
    closeSockets() {
      for (const socket of sockets) socket.close(1000, "isolated connection smoke");
    },
  });
}

async function waitForMainWindow(application) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    for (const page of application.windows()) {
      const isMain = await page
        .evaluate(() => globalThis.desktopBridge?.getWindowRole() === "main")
        .catch(() => false);
      if (isMain) return page;
    }
    await delay(100);
  }
  throw new Error("Packaged application did not create its main window.");
}

async function readStats(page) {
  return page.evaluate(() => ({ ...Reflect.get(globalThis, "__bigbudConnectionSmoke")?.stats }));
}

async function waitForSnapshot(page, minimum) {
  await page.waitForFunction(
    (count) => Reflect.get(globalThis, "__bigbudConnectionSmoke")?.stats.configSnapshots >= count,
    minimum,
    { timeout: 90_000 },
  );
}

async function assertNoBlockingSurface(page) {
  const explicitBlockingState = await page
    .locator('[data-testid="connection-blocking-state"]')
    .isVisible();
  assert.equal(
    explicitBlockingState,
    false,
    "The packaged renderer retained its blocking connection surface.",
  );
  const blocked = await page.evaluate(() =>
    Array.from(document.querySelectorAll("h1,h2")).some((element) => {
      if (element.getClientRects().length === 0) return false;
      const text = element.textContent ?? "";
      return (
        /connecting to bigbud|cannot reach.*bigbud|local backend.*(stopped|taking too long)/iu.test(
          text,
        ) || /config(?:uration)?.*(failed|unavailable|rejected|exhausted|could not)/iu.test(text)
      );
    }),
  );
  assert.equal(blocked, false, "The packaged renderer displayed a blocking startup/config error.");
}

/** Measures only the fixture process tree; no command arguments or environment are collected. */
async function readOwnedMemory(rootPid) {
  if (process.platform === "win32") return null;
  const { stdout } = await executeFile("ps", ["-axo", "pid=,ppid=,rss="], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const processes = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isFinite));
  const owned = new Set([rootPid]);
  let previousSize;
  do {
    previousSize = owned.size;
    for (const [pid, parent] of processes) {
      if (owned.has(parent)) owned.add(pid);
    }
  } while (owned.size !== previousSize);
  const rows = processes.filter(([pid]) => owned.has(pid));
  assert.ok(
    rows.some(([pid]) => pid === rootPid),
    "The fixture process tree could not be measured.",
  );
  return { processes: rows.length, rssKiB: rows.reduce((sum, row) => sum + row[2], 0) };
}

/** Escalation is limited to the ChildProcess created by this smoke run. */
async function terminateOwnedProcess(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let onExit;
  const exited = new Promise((resolveExit) => {
    onExit = () => resolveExit(true);
    child.once("exit", onExit);
  });
  let timeout;
  try {
    if (!child.kill(signal)) return child.exitCode !== null || child.signalCode !== null;
    return await Promise.race([
      exited,
      new Promise((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    child.off("exit", onExit);
  }
}

async function closeOwnedApplication(application) {
  const child = application.process();
  let timeout;
  try {
    await Promise.race([
      application.close(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Smoke application shutdown timed out.")),
          15_000,
        );
      }),
    ]);
  } catch (error) {
    if (!(await terminateOwnedProcess(child, "SIGTERM"))) {
      if (!(await terminateOwnedProcess(child, "SIGKILL"))) {
        throw new AggregateError([error], "The owned smoke application could not be stopped.", {
          cause: error,
        });
      }
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runConnectionSmoke() {
  const options = readOptions();
  const fixture = await createConnectionSmokeFixture();
  let application;
  let summary;
  try {
    application = await electron.launch({
      executablePath: options.executable,
      cwd: fixture.workspace,
      env: fixture.environment,
      timeout: 90_000,
    });
    const identity = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      profile: app.getPath("userData"),
    }));
    assert.equal(
      identity.packaged,
      true,
      "The smoke target must be a packaged Electron application.",
    );
    await fixture.assertProfileIsIsolated(identity.profile);
    await application.context().addInitScript(instrumentWebSockets);
    const page = await waitForMainWindow(application);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
    await waitForSnapshot(page, 1);

    const startedAt = Date.now();
    const samples = [];
    let nextSampleAt = startedAt;
    let forcedReconnects = 0;
    const reconnectOffsets = options.durationMs >= 240_000 ? [75_000, 180_000] : [5_000, 15_000];
    while (Date.now() - startedAt < options.durationMs) {
      assert.equal(
        application.process().exitCode,
        null,
        "The isolated application exited during the soak.",
      );
      const elapsedMs = Date.now() - startedAt;
      if (
        forcedReconnects < reconnectOffsets.length &&
        elapsedMs >= reconnectOffsets[forcedReconnects]
      ) {
        const previous = await readStats(page);
        await page.evaluate(() =>
          Reflect.get(globalThis, "__bigbudConnectionSmoke").closeSockets(),
        );
        await waitForSnapshot(page, previous.configSnapshots + 1);
        forcedReconnects += 1;
      }
      if (Date.now() >= nextSampleAt) {
        if (elapsedMs >= 65_000) await assertNoBlockingSurface(page);
        samples.push({
          elapsedMs,
          transport: await readStats(page),
          memory: await readOwnedMemory(application.process().pid),
        });
        nextSampleAt = Date.now() + 60_000;
      }
      await delay(Math.min(2_000, Math.max(1, options.durationMs - (Date.now() - startedAt))));
    }
    await assertNoBlockingSurface(page);
    const transport = await readStats(page);
    assert.equal(
      forcedReconnects,
      2,
      "Both controlled disconnects must recover without reloading.",
    );
    assert.equal(
      transport.configFailures,
      0,
      "The isolated fixture rejected configuration responses.",
    );
    assert.equal(
      transport.defects,
      0,
      "The isolated fixture received connection-wide RPC defects.",
    );
    assert.ok(
      transport.configRequests <= 12,
      "Configuration subscriptions accumulated during the soak.",
    );
    const report = { durationMs: Date.now() - startedAt, forcedReconnects, transport, samples };
    await writeFile(
      join(fixture.root, "connection-smoke.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    summary = { passed: true, report: join(fixture.root, "connection-smoke.json"), ...report };
  } finally {
    try {
      if (application) await closeOwnedApplication(application);
    } finally {
      await fixture.releaseAlias();
    }
  }
  console.log(JSON.stringify(summary));
}

runConnectionSmoke().catch((error) => {
  console.error(`Packaged connection smoke failed: ${sanitizeConnectionSmokeError(error)}`);
  process.exitCode = 1;
});
