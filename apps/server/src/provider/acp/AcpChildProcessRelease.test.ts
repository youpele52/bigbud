import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
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

  // A scope closed because its fiber was interrupted runs its finalizers in that interrupted
  // fiber; the release must still escalate, and `afterRelease` must still run.
  for (const mode of ["interrupted", "timed out"] as const) {
    it(`SIGKILLs a SIGTERM-ignoring group member when the owning fiber is ${mode}`, async () => {
      let pid = 0;
      let afterReleaseRan = false;
      await Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const use = Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const scope = yield* Scope.Scope;
          const child = yield* spawner.spawn(
            ChildProcess.make("sh", ["-c", "(trap '' TERM; exec sleep 30) & echo ready; wait"], {
              forceKillAfter: "300 millis",
            }),
          );
          pid = Number(child.pid);
          yield* addBoundedChildRelease(
            scope,
            child,
            "300 millis",
            Effect.sync(() => void (afterReleaseRan = true)),
          );
          yield* child.stdout.pipe(Stream.take(1), Stream.runDrain);
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }).pipe(Effect.scoped);
        if (mode === "timed out") {
          // Ample margin for the spawn and `ready`; `pid > 0` below fails loudly if it was not.
          yield* use.pipe(Effect.timeoutOption("1 second"));
          return;
        }
        // Interrupt only once the release is registered and the member is running.
        const fiber = yield* Effect.forkChild(use);
        yield* Deferred.await(ready);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
      expect(pid).toBeGreaterThan(0);
      expect(groupAlive(pid)).toBe(false);
      expect(afterReleaseRan).toBe(true);
    });
  }
});
