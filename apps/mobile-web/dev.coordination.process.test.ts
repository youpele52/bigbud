import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, it } from "vitest";
import { coordinatedTestPort } from "./dev.coordination.test.helpers.ts";

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
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
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
});

function launch(role: "web" | "mobile") {
  const child = fork(
    fileURLToPath(new URL("./dev.coordination.fixture.ts", import.meta.url)),
    [role, root, String(firstPort)],
    { execArgv: [], silent: true },
  );
  children.push(child);
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  const pending: Array<{ status: string; port: number; error?: string }> = [];
  let notify: (() => void) | undefined;
  child.on("message", (message) => {
    pending.push(message as { status: string; port: number; error?: string });
    notify?.();
  });
  child.on("exit", () => notify?.());
  return {
    child,
    async next(status: string) {
      const result = await new Promise<{ status: string; port: number; error?: string }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Fixture timed out: ${diagnostics}`)),
            8_000,
          );
          notify = () => {
            const value = pending.shift();
            if (value) {
              clearTimeout(timer);
              notify = undefined;
              resolve(value);
            } else if (child.exitCode !== null || child.signalCode !== null) {
              clearTimeout(timer);
              notify = undefined;
              reject(new Error(`Fixture exited: ${diagnostics}`));
            }
          };
          notify();
        },
      );
      expect(result.status, result.error ?? diagnostics).toBe(status);
      return result.port;
    },
  };
}

it("protects an unbound web reservation from a separate mobile process", async () => {
  const web = launch("web");
  expect(await web.next("reserved")).toBe(firstPort);
  const mobile = launch("mobile");
  const mobilePort = await mobile.next("bound");
  expect(mobilePort).toBeGreaterThan(firstPort);
  web.child.send("bind");
  expect(await web.next("bound")).toBe(firstPort);
  expect(
    await fetch(`http://127.0.0.1:${firstPort}/__bigbud/mobile-dev`).then((r) => r.json()),
  ).toEqual({ url: `http://127.0.0.1:${mobilePort}` });
});

it("lets a separate web process skip the already listening mobile process", async () => {
  const mobile = launch("mobile");
  expect(await mobile.next("bound")).toBe(firstPort);
  const web = launch("web");
  const webPort = await web.next("reserved");
  expect(webPort).toBeGreaterThan(firstPort);
  web.child.send("bind");
  expect(await web.next("bound")).toBe(webPort);
  expect(
    await fetch(`http://127.0.0.1:${webPort}/__bigbud/mobile-dev`).then((r) => r.json()),
  ).toEqual({ url: `http://127.0.0.1:${firstPort}` });
});
