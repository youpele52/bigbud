import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProjectDirectoryWatchEvent } from "@bigbud/contracts/workspace/project";

import { makeLocalWorkspaceWatch } from "./localWorkspaceWatch.ts";
import { LocalWorkspaceWatchAgent } from "./localWorkspaceWatchAgent.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const binaryPath = join(
  repoRoot,
  "target",
  "debug",
  process.platform === "win32" ? "bigbud-remote-agent.exe" : "bigbud-remote-agent",
);
const temporaryRoots: string[] = [];

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

beforeAll(() => {
  const build = spawnSync("cargo", ["build", "--locked", "--package", "bigbud-remote-agent"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) throw new Error("Failed to build the real workspace watcher child.");
});

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe("local workspace watcher child integration", () => {
  it("delivers exact preview changes across an actual child crash and restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "bigbud-local-watch-integration-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "src"));
    const previewPath = "src/example.txt";
    writeFileSync(join(root, previewPath), "before");
    const agent = new LocalWorkspaceWatchAgent({
      resolveBinary: () => binaryPath,
      restartDelayMs: 25,
    });
    const events: ProjectDirectoryWatchEvent[] = [];
    let previewRefreshes = 0;
    const watch = makeLocalWorkspaceWatch(agent, { reconnectDelayMs: 50 }).watchDirectory({
      cwd: root,
      relativePath: "src",
      executionTargetId: "local",
    });
    const consume = Effect.runPromise(
      Effect.flatMap(watch, (stream) =>
        Stream.runForEach(Stream.take(stream, 4), (event) =>
          Effect.sync(() => {
            events.push(event);
            if (
              event.version === 2 &&
              event.type === "directoryChanged" &&
              event.changedPaths.includes(previewPath)
            ) {
              previewRefreshes += 1;
            }
          }),
        ),
      ),
    );

    try {
      await waitFor(() => agent.processId !== undefined, "watcher child did not start");
      const firstProcessId = agent.processId!;
      const firstEpoch = agent.agentEpoch!;
      writeFileSync(join(root, previewPath), "first external change");
      await waitFor(() => previewRefreshes === 1, "first exact preview refresh was not delivered");

      process.kill(firstProcessId, "SIGKILL");
      await waitFor(
        () =>
          events.some(
            (event) => event.type === "rescanRequired" && event.reason === "transportLost",
          ),
        "transport loss was not surfaced",
      );
      await waitFor(
        () =>
          agent.processId !== undefined &&
          agent.processId !== firstProcessId &&
          agent.agentEpoch !== undefined &&
          agent.agentEpoch !== firstEpoch &&
          events.some(
            (event) => event.type === "rescanRequired" && event.reason === "agentRestarted",
          ),
        "watcher child did not restart with a new epoch",
      );

      writeFileSync(join(root, previewPath), "second external change");
      await consume;
      expect(previewRefreshes).toBe(2);
      expect(
        events.map((event) => (event.type === "rescanRequired" ? event.reason : event.type)),
      ).toEqual(["directoryChanged", "transportLost", "agentRestarted", "directoryChanged"]);
      expect(events.at(-1)).toMatchObject({ backend: expect.stringMatching(/native|poll/) });
    } finally {
      agent.close();
      await consume.catch(() => undefined);
    }
  });
});
