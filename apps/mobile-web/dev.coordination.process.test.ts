import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, it } from "vitest";
import { coordinatedTestPort } from "./dev.coordination.test.helpers.ts";

const IPC_READY_TIMEOUT_MS = 15_000;
const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_KILL_TIMEOUT_MS = 5_000;
const DIAGNOSTICS_LIMIT = 4_000;

let root: string;
let firstPort: number;
const children: ChildProcess[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bigbud-dev-order-process-test-"));
  firstPort = await coordinatedTestPort();
});
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      const timeout = setTimeout(() => child.kill("SIGKILL"), CLEANUP_KILL_TIMEOUT_MS);
      if (child.connected) child.send("stop");
      else child.kill("SIGTERM");
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  await rm(root, { recursive: true, force: true });
}, CLEANUP_TIMEOUT_MS);

function launch(role: "web" | "mobile") {
  const child = fork(
    fileURLToPath(new URL("./dev.coordination.fixture.ts", import.meta.url)),
    [role, root, String(firstPort)],
    { execArgv: [], silent: true },
  );
  children.push(child);
  let diagnostics = "";
  let childError: string | undefined;
  let phase = "starting";
  const pending: Array<{ status: string; port: number; error?: string }> = [];
  let notify: (() => void) | undefined;
  child.stderr?.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  child.on("error", (error) => {
    childError = String(error);
    notify?.();
  });
  child.on("message", (message) => {
    pending.push(message as { status: string; port: number; error?: string });
    notify?.();
  });
  child.on("exit", () => notify?.());
  const failureDetails = () => {
    const lifecycle =
      child.exitCode !== null || child.signalCode !== null
        ? `exitCode=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"}`
        : "still running";
    const stderr = diagnostics.trim().slice(-DIAGNOSTICS_LIMIT) || "<none>";
    const error = childError ? `, error=${childError}` : "";
    return `Fixture ${role} ${phase} failed (${lifecycle}${error}); stderr: ${stderr}`;
  };
  return {
    child,
    async next(status: string) {
      phase = `waiting for ${JSON.stringify(status)}`;
      const result = await new Promise<{ status: string; port: number; error?: string }>(
        (resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let wake: () => void;
          const settle = (finish: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (notify === wake) notify = undefined;
            finish();
          };
          wake = () => {
            const value = pending.shift();
            if (value) {
              settle(() => resolve(value));
            } else if (child.exitCode !== null || child.signalCode !== null) {
              settle(() => reject(new Error(failureDetails())));
            }
          };
          notify = wake;
          timer = setTimeout(
            () =>
              settle(() =>
                reject(
                  new Error(
                    `Fixture timed out after ${IPC_READY_TIMEOUT_MS}ms: ${failureDetails()}`,
                  ),
                ),
              ),
            IPC_READY_TIMEOUT_MS,
          );
          notify();
        },
      );
      expect(result.status, result.error ?? failureDetails()).toBe(status);
      return result.port;
    },
  };
}

it(
  "protects an unbound web reservation from a separate mobile process",
  async () => {
    const web = launch("web");
    const reservedWebPort = await web.next("reserved");
    expect(reservedWebPort).toBeGreaterThanOrEqual(firstPort);
    const mobile = launch("mobile");
    const mobilePort = await mobile.next("bound");
    expect(mobilePort).toBeGreaterThanOrEqual(firstPort);
    expect(mobilePort).not.toBe(reservedWebPort);
    web.child.send("bind");
    expect(await web.next("bound")).toBe(reservedWebPort);
    expect(
      await fetch(`http://127.0.0.1:${reservedWebPort}/__bigbud/mobile-dev`).then((r) => r.json()),
    ).toEqual({ url: `http://127.0.0.1:${mobilePort}` });
  },
  SUBPROCESS_TEST_TIMEOUT_MS,
);

it(
  "lets a separate web process skip the already listening mobile process",
  async () => {
    const mobile = launch("mobile");
    const mobilePort = await mobile.next("bound");
    expect(mobilePort).toBeGreaterThanOrEqual(firstPort);
    const web = launch("web");
    const webPort = await web.next("reserved");
    expect(webPort).toBeGreaterThanOrEqual(firstPort);
    expect(webPort).not.toBe(mobilePort);
    web.child.send("bind");
    expect(await web.next("bound")).toBe(webPort);
    expect(
      await fetch(`http://127.0.0.1:${webPort}/__bigbud/mobile-dev`).then((r) => r.json()),
    ).toEqual({ url: `http://127.0.0.1:${mobilePort}` });
  },
  SUBPROCESS_TEST_TIMEOUT_MS,
);
