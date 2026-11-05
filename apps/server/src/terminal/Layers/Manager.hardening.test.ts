import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { expect } from "vitest";

import { FakePtyAdapter, createManager, openInput, waitFor } from "./Manager.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager hardening", (it) => {
  it.effect("ends in the error state when the adapter throws during spawn", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();
      ptyAdapter.spawnDefects.push(new Error("native spawn exploded"));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "error");
      const events = yield* getEvents;
      const error = events.find((event) => event.type === "error");
      expect(error?.type === "error" ? error.message : "").toContain("native spawn exploded");
    }),
  );

  it.effect("ends in the error state when the adapter throws before returning an Effect", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      ptyAdapter.spawnThrows.push(new Error("adapter threw eagerly"));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "error");
    }),
  );

  it.effect("falls back to the next shell when a spawn defect looks like a missing shell", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/definitely/missing-shell",
      });
      ptyAdapter.spawnDefects.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/definitely/missing-shell");
    }),
  );

  it.effect("returns a typed error when resize or write hits a closed descriptor", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.throwOnResize = true;
      process.throwOnWrite = true;

      const resizeError = yield* Effect.flip(
        manager.resize({ threadId: "thread-1", cols: 90, rows: 30 }),
      );
      const writeError = yield* Effect.flip(manager.write({ threadId: "thread-1", data: "ls\r" }));

      assert.equal(resizeError._tag, "TerminalNotRunningError");
      assert.equal(writeError._tag, "TerminalNotRunningError");
    }),
  );

  it.effect("reattaches when the reattach resize races an exiting process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      ptyAdapter.processes[0]!.throwOnResize = true;

      const snapshot = yield* manager.open(openInput({ cols: 120, rows: 40 }));

      assert.equal(snapshot.status, "running");
      assert.equal(ptyAdapter.processes.length, 1);
    }),
  );

  it.effect("never evicts a session that is still starting", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        maxRetainedInactiveSessions: 0,
      });
      yield* manager.open(openInput({ threadId: "thread-b" }));
      const exiting = ptyAdapter.processes[0]!;

      const releases: Array<() => void> = [];
      ptyAdapter.spawnGate = new Promise<void>((resolve) => releases.push(resolve));
      const opening = yield* manager
        .open(openInput({ threadId: "thread-a" }))
        .pipe(Effect.forkChild);
      yield* waitFor(Effect.sync(() => ptyAdapter.spawnInputs.length === 2));

      // Another thread's exit drain runs eviction while thread-a is mid-spawn.
      exiting.emitExit({ exitCode: 0, signal: null });
      yield* waitFor(
        manager.write({ threadId: "thread-b", data: "x" }).pipe(
          Effect.as(false),
          Effect.catch(() => Effect.succeed(true)),
        ),
      );

      ptyAdapter.spawnGate = null;
      for (const release of releases) release();
      const snapshot = yield* Fiber.join(opening);

      assert.equal(snapshot.status, "running");
      yield* manager.write({ threadId: "thread-a", data: "echo ok\r" });
      expect(ptyAdapter.processes[1]?.writes).toContain("echo ok\r");
    }),
  );
});
