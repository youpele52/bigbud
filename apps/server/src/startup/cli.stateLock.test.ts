import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, beforeEach, expect, it } from "vitest";

import { holdBackendLockForCli } from "../cli/cli.backendLock.ts";
import { acquireStateDirLock } from "./stateDirLock.ts";

let base: string;
let stateDir: string;
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bigbud-cli-lock-"));
  stateDir = path.join(base, "userdata");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const hold = () =>
  Effect.scoped(
    holdBackendLockForCli({
      stateDir,
      port: 0,
      command: "legacy-orphan-recovery",
      mode: "read",
    }),
  );

it("refuses a second opener while the first owner is still healthy", async () => {
  const first = await acquireStateDirLock({ stateDir, port: 0 });
  try {
    const blocked = await Effect.runPromise(hold()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(blocked).toBeInstanceOf(Error);
    expect((blocked as Error).message).toContain(
      "legacy-orphan-recovery reads the bigbud database",
    );
    // The first owner's record is unchanged and still releasable.
    const record = first.record;
    expect(record.pid).toBe(process.pid);
  } finally {
    await first.release();
  }
  await expect(Effect.runPromise(hold())).resolves.toMatchObject({
    lockPath: expect.any(String),
  });
});

it("releases the lock when the command fails", async () => {
  const failed = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* holdBackendLockForCli({
          stateDir,
          port: 0,
          command: "canonical-thread-cleanup",
          mode: "write",
        });
        return yield* Effect.fail(new Error("command failed after opening"));
      }),
    ),
  );
  expect(Exit.isFailure(failed)).toBe(true);
  const next = await acquireStateDirLock({ stateDir, port: 0 });
  await next.release();
});

const cliPath = path.join(
  fileURLToPath(new URL("../../../../", import.meta.url)),
  "apps/server/src/bin.ts",
);

async function runCli(command: string) {
  const extra = command === "canonical-thread-cleanup" ? ["--limit", "1"] : [];
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn("bun", ["run", cliPath, command, ...extra, "--base-dir", base], {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

it.each([
  "canonical-thread-cleanup",
  "canonical-event-compaction",
  "legacy-orphan-recovery",
] as const)(
  "makes %s take the backend lock before opening the database",
  async (command) => {
    const owner = await acquireStateDirLock({ stateDir, port: 0 });
    try {
      const result = await runCli(command);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(`${command} reads the bigbud database`);
      expect(result.output).toContain("Another bigbud backend");
    } finally {
      await owner.release();
    }
  },
  30_000,
);
