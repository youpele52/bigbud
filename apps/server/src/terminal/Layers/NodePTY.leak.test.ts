import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { PtyAdapter, type PtyExitEvent, type PtyProcess } from "../Services/PTY";
import * as NodePTY from "./NodePTY";

// Regression guard for node-pty 1.1.0 leaking pseudo-terminal fds on macOS (one `/dev/ptmx`
// master per spawn, plus the slave on a failed spawn); a long-running server then exhausts
// kern.tty.ptmx_max. Counts masters (`/dev/ptmx`) and slaves (`/dev/ttysN`, `/dev/pts/N`).
const LSOF_PATH = ["/usr/sbin/lsof", "/usr/bin/lsof"].find((candidate) => existsSync(candidate));
const SKIP_REASON =
  process.platform === "win32"
    ? "Windows ConPTY does not use /dev/ptmx pseudo-terminals"
    : LSOF_PATH === undefined
      ? "lsof is unavailable, so open pseudo-terminal descriptors cannot be counted"
      : null;
// The latest stable node-pty (1.1.0) still leaks on macOS; 1.2.0-beta.15 fixes it. bigbud stays on
// stable, so these cases are expected failures there. When a stable release fixes the leak they
// start passing, `it.fails` reports that, and this guard should be removed.
const NODE_PTY_VERSION: string = createRequire(import.meta.url)("node-pty/package.json").version;
const KNOWN_STABLE_LEAK = process.platform === "darwin" && NODE_PTY_VERSION === "1.1.0";
const leakCase = KNOWN_STABLE_LEAK ? it.fails : it;
const SPAWN_COUNT = 10;
const SETTLE_TIMEOUT_MS = 5_000;
const SHELL_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const PTY_DEVICE_PATTERN = /^n\/dev\/(?:ptmx|ttys\d+|pts\/\d+)$/;

function countOpenPtyDescriptors(): number {
  const output = execFileSync(LSOF_PATH!, ["-n", "-P", "-p", String(process.pid), "-Fn"], {
    encoding: "utf8",
  });
  return output.split("\n").filter((line) => PTY_DEVICE_PATTERN.test(line)).length;
}

async function waitForPtyCount(expected: number): Promise<number> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let current = countOpenPtyDescriptors();
  while (current !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = countOpenPtyDescriptors();
  }
  return current;
}

const adapter = Effect.runPromise(
  Effect.gen(function* () {
    return yield* PtyAdapter;
  }).pipe(Effect.provide(NodePTY.layer.pipe(Layer.provide(NodeServices.layer)))),
);

function waitForExit(processHandle: PtyProcess): Promise<PtyExitEvent> {
  return new Promise((resolve) => {
    processHandle.onExit(resolve);
  });
}

describe.skipIf(SKIP_REASON !== null)("NodePTY pseudo-terminal descriptor lifetime", () => {
  leakCase(`returns to the baseline after ${SPAWN_COUNT} exited or killed PTYs`, async () => {
    const pty = await adapter;
    const baseline = countOpenPtyDescriptors();

    for (let index = 0; index < SPAWN_COUNT; index += 1) {
      const killed = index % 2 === 1;
      const processHandle = await Effect.runPromise(
        pty.spawn({
          shell: "/bin/sh",
          args: ["-c", killed ? "sleep 30" : "exit 0"],
          cwd: tmpdir(),
          cols: 80,
          rows: 24,
          env: SHELL_ENV,
        }),
      );
      const exited = waitForExit(processHandle);
      if (killed) processHandle.kill("SIGKILL");
      await exited;
    }

    expect(await waitForPtyCount(baseline)).toBe(baseline);
  });

  leakCase("returns to the baseline after failed spawns", async () => {
    const pty = await adapter;
    const baseline = countOpenPtyDescriptors();

    for (let index = 0; index < SPAWN_COUNT; index += 1) {
      const exit = await Effect.runPromiseExit(
        pty.spawn({
          shell: "/nonexistent/bigbud-node-pty-leak-test-shell",
          args: [],
          cwd: tmpdir(),
          cols: 80,
          rows: 24,
          env: SHELL_ENV,
        }),
      );
      if (Exit.isSuccess(exit)) await waitForExit(exit.value);
    }

    expect(await waitForPtyCount(baseline)).toBe(baseline);
  });
});

describe.skipIf(SKIP_REASON === null)(
  "NodePTY pseudo-terminal descriptor lifetime (unmeasurable)",
  () => {
    it.skip(`skipped: ${SKIP_REASON}`, () => {});
  },
);
