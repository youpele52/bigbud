import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import type { PtySpawnInput } from "../Services/PTY";
import {
  FakePtyAdapter,
  type FakePtyProcess,
  createManager,
  openInput,
  restartInput,
  waitFor,
} from "./Manager.test.helpers";

class ErrorPtyAdapter extends FakePtyAdapter {
  readonly listeners = new Map<FakePtyProcess, Set<(error: Error) => void>>();
  readonly captured: Array<(error: Error) => void> = [];
  initialFailure: Error | null = null;

  override spawn(input: PtySpawnInput) {
    return super.spawn(input).pipe(
      Effect.map((process) => {
        const listeners = new Set<(error: Error) => void>();
        this.listeners.set(process as FakePtyProcess, listeners);
        const failure = this.initialFailure;
        return Object.assign(process, {
          onError: (callback: (error: Error) => void) => {
            listeners.add(callback);
            this.captured.push(callback);
            if (failure) callback(failure);
            return () => {
              listeners.delete(callback);
            };
          },
        });
      }),
    );
  }

  fail(process: FakePtyProcess) {
    for (const callback of this.listeners.get(process) ?? [])
      callback(new Error("Terminal PTY read failed: EBADF. Shutdown is not yet confirmed."));
  }
}

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "terminal process read failure",
  (it) => {
    it.effect(
      "publishes visible error, retains ownership and accepts only real exit confirmation",
      () =>
        Effect.gen(function* () {
          const ptyAdapter = new ErrorPtyAdapter();
          const releases: unknown[] = [];
          const { manager, getEvents } = yield* createManager(5, {
            ptyAdapter,
            releaseWorktreeLease: (input) =>
              Effect.sync(() => {
                releases.push(input);
              }),
          });
          const started = yield* manager.open(openInput());
          const process = ptyAdapter.processes[0]!;
          process.exitOnSignal = null;
          process.emitData("diagnostic output\r\n");
          ptyAdapter.fail(process);
          ptyAdapter.fail(process);
          yield* waitFor(
            getEvents.pipe(Effect.map((events) => events.some((e) => e.type === "error"))),
          );

          const failed = yield* manager.open(openInput());
          expect(failed.status).toBe("error");
          expect(failed.pid).toBe(process.pid);
          expect(failed.runtimeGeneration).toBe(started.runtimeGeneration);
          expect(failed.exitCode).toBeNull();
          expect(failed.exitSignal).toBeNull();
          expect(ptyAdapter.processes).toHaveLength(1);
          expect(releases).toEqual([]);
          const writeError = yield* manager
            .write({ threadId: "thread-1", data: "ls\r" })
            .pipe(Effect.flip);
          expect(writeError._tag).toBe("TerminalNotRunningError");
          const events = yield* getEvents;
          expect(events.filter((e) => e.type === "error")).toHaveLength(1);
          expect(events.some((e) => e.type === "exited")).toBe(false);

          process.emitExit({ exitCode: 17, signal: 9 });
          yield* waitFor(
            getEvents.pipe(Effect.map((events) => events.some((e) => e.type === "exited"))),
          );
          const exited = (yield* getEvents).find((e) => e.type === "exited");
          expect(exited).toMatchObject({
            exitCode: 17,
            exitSignal: 9,
            runtimeGeneration: started.runtimeGeneration,
          });
          yield* waitFor(Effect.sync(() => releases.length === 1));
          expect(ptyAdapter.listeners.get(process)?.size).toBe(0);
        }),
    );

    it.effect("replays a failure that occurred before the manager subscribed", () =>
      Effect.gen(function* () {
        const ptyAdapter = new ErrorPtyAdapter();
        ptyAdapter.initialFailure = new Error("early read failure");
        const { manager, getEvents } = yield* createManager(5, { ptyAdapter });
        yield* manager.open(openInput());
        yield* waitFor(
          getEvents.pipe(Effect.map((events) => events.some((e) => e.type === "error"))),
        );
        expect((yield* manager.open(openInput())).status).toBe("error");
        expect(ptyAdapter.processes).toHaveLength(1);
        ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: null });
      }),
    );

    it.effect("ignores stale callbacks after replacement even if the PID is reused", () =>
      Effect.gen(function* () {
        const ptyAdapter = new ErrorPtyAdapter();
        const { manager, getEvents } = yield* createManager(5, { ptyAdapter });
        yield* manager.open(openInput());
        const old = ptyAdapter.processes[0]!;
        const staleError = ptyAdapter.captured[0]!;
        const current = yield* manager.restart(restartInput());
        Object.defineProperty(old, "pid", { value: current.pid });
        staleError(new Error("late error from the old process"));
        yield* Effect.yieldNow;
        expect((yield* manager.open(openInput())).status).toBe("running");
        expect((yield* getEvents).some((e) => e.type === "error")).toBe(false);
        expect(ptyAdapter.listeners.get(old)?.size).toBe(0);
      }),
    );
  },
);
