import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import { addBoundedChildRelease } from "./AcpChildProcessRelease.ts";

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Spawn `script` the way AcpSessionRuntime does (default detached group), register the bounded
 * release, close the scope from an uninterruptible region like layer teardown, and time it.
 */
const closeAfterSpawn = (script: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.make();
    const child = yield* spawner
      .spawn(ChildProcess.make("sh", ["-c", script], { forceKillAfter: "300 millis" }))
      .pipe(Effect.provideService(Scope.Scope, scope));
    yield* addBoundedChildRelease(scope, child, "300 millis");
    // Wait until the script has installed its traps and started its grandchild.
    yield* child.stdout.pipe(Stream.take(1), Stream.runDrain);
    const startedAt = Date.now();
    yield* Effect.uninterruptible(Scope.close(scope, Exit.void));
    return { elapsedMs: Date.now() - startedAt, pid: Number(child.pid) };
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

describe.skipIf(process.platform === "win32")("addBoundedChildRelease", () => {
  it("lets a cooperative agent exit on SIGTERM without escalating", async () => {
    const { elapsedMs, pid } = await closeAfterSpawn("echo ready; exec sleep 30");
    expect(elapsedMs).toBeLessThan(300);
    expect(groupAlive(pid)).toBe(false);
  });

  it("SIGKILLs an agent group that ignores SIGTERM, including its grandchild", async () => {
    // `trap ''` is inherited, so the background grandchild ignores SIGTERM too.
    const { elapsedMs, pid } = await closeAfterSpawn("trap '' TERM; sleep 30 & echo ready; wait");
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(groupAlive(pid)).toBe(false);
  });

  it("SIGKILLs a group member that ignores SIGTERM after its leader exits", async () => {
    // The leader exits on SIGTERM; the subshell (Cursor's worker in real life) ignores it.
    const { elapsedMs, pid } = await closeAfterSpawn(
      "(trap '' TERM; exec sleep 30) & echo ready; wait",
    );
    expect(elapsedMs).toBeLessThan(2_000);
    expect(groupAlive(pid)).toBe(false);
  });
});
