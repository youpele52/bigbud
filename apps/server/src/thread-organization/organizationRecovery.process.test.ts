import { execFile, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withDatabase } from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";

const binary = resolve(
  import.meta.dirname,
  "../../../../target/debug/bigbud-desktop-supervisor" +
    (process.platform === "win32" ? ".exe" : ""),
);
let directory: string | undefined;
let entry = "";
beforeAll(async () => {
  if (!existsSync(binary)) return;
  directory = await mkdtemp(join(tmpdir(), "inyosira-crash-fixture-"));
  entry = join(directory, "worker.mjs");
  await symlink(
    resolve(import.meta.dirname, "../../node_modules"),
    join(directory, "node_modules"),
    "junction",
  );
  await promisify(execFile)("bun", [
    "build",
    resolve(import.meta.dirname, "organizationRecovery.process.fixture.ts"),
    "--target=node",
    "--external=playwright",
    "--external=@effect/sql-sqlite-bun/*",
    `--outfile=${entry}`,
  ]);
}, 30000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
function worker(path: string, phase: string, oldId = "") {
  const child = fork(entry, [path, binary, phase, oldId], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4000);
  });
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const message = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`recovery worker timed out: ${diagnostics}`)),
      25000,
    );
    child.once("message", (value) => {
      clearTimeout(timer);
      resolve(value as Record<string, unknown>);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`recovery worker exited ${code}/${signal}: ${diagnostics}`));
    });
  });
  return {
    message,
    exit,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    },
  };
}

it.skipIf(!existsSync(binary)).each(["prepared", "committed"])(
  "TS process killed after %s recovers against the real Rust scheduler without duplicate moves",
  (phase) =>
    withDatabase("inyosira-process-recovery-", async (path) => {
      const first = worker(path, phase);
      let second: ReturnType<typeof worker> | undefined;
      try {
        const barrier = await first.message;
        expect(barrier.state).toBe("barrier");
        await first.stop();
        second = worker(path, "recover", String(barrier.operationId));
        const recovered = await second.message;
        expect(recovered).toMatchObject({
          state: "recovered",
          revision: 1,
          count: 1,
          pending: 0,
          outcome: { status: phase === "prepared" ? "stale" : "applied" },
        });
        if (phase === "committed") expect(recovered.outcome).toEqual(barrier.outcome);
        await second.exit;
      } finally {
        await first.stop();
        await second?.stop();
      }
    }),
  60000,
);
