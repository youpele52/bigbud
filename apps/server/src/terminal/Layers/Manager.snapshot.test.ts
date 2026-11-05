import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import type { PtySpawnInput } from "../Services/PTY";
import {
  FakePtyAdapter,
  createManager,
  openInput,
  restartInput,
  waitFor,
} from "./Manager.test.helpers";

class ErrorPtyAdapter extends FakePtyAdapter {
  reportError: (error: Error) => void = () => undefined;

  override spawn(input: PtySpawnInput) {
    return super.spawn(input).pipe(
      Effect.map((process) =>
        Object.assign(process, {
          onError: (callback: (error: Error) => void) => {
            this.reportError = callback;
            return () => {
              this.reportError = () => undefined;
            };
          },
        }),
      ),
    );
  }
}

it.layer(NodeServices.layer, { excludeTestServices: true })("view-only terminal recovery", (it) => {
  it.effect("refuses missing sessions and reads running sessions without spawn or resize", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const input = openInput();
      const missing = yield* manager.snapshot(input).pipe(Effect.flip);
      expect(missing._tag).toBe("TerminalSessionLookupError");
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
      const opened = yield* manager.open(input);
      expect(yield* manager.snapshot({ threadId: input.threadId })).toEqual(opened);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes[0]!.resizeCalls).toHaveLength(0);
    }),
  );

  it.effect(
    "reads the authoritative retained exited generation after stale lifecycle rejection",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager();
        const input = openInput();
        const original = yield* manager.open(input);
        const current = yield* manager.restart(
          restartInput({ expectedGeneration: original.runtimeGeneration }),
        );
        const process = ptyAdapter.processes[1]!;
        process.emitData("retained diagnostic output\r\n");
        process.emitExit({ exitCode: 17, signal: 9 });
        yield* waitFor(
          getEvents.pipe(
            Effect.map((events) =>
              events.some(
                (event) =>
                  event.type === "exited" && event.runtimeGeneration === current.runtimeGeneration,
              ),
            ),
          ),
        );
        const staleClose = yield* manager
          .close({
            threadId: input.threadId,
            terminalId: input.terminalId,
            expectedGeneration: original.runtimeGeneration,
          })
          .pipe(Effect.flip);
        expect(staleClose._tag).toBe("TerminalExecutionTargetError");
        const eventsBefore = yield* getEvents;
        const retained = yield* manager.snapshot(input);
        expect(retained).toMatchObject({
          threadId: current.threadId,
          terminalId: current.terminalId,
          executionTargetId: current.executionTargetId,
          runtimeGeneration: current.runtimeGeneration,
          status: "exited",
          pid: null,
          history: "retained diagnostic output\r\n",
          exitCode: 17,
          exitSignal: 9,
        });
        expect(yield* manager.snapshot(input)).toEqual(retained);
        expect(yield* getEvents).toEqual(eventsBefore);
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        expect(process.resizeCalls).toEqual([]);
        expect(process.killSignals).toEqual([]);
        expect(process.writes).toEqual([]);
      }),
  );

  it.effect(
    "reads a processless launch-error snapshot without retrying spawn or inventing exit",
    () =>
      Effect.gen(function* () {
        const ptyAdapter = new FakePtyAdapter();
        ptyAdapter.spawnFailures.push(new Error("launch failed"));
        const { manager, getEvents } = yield* createManager(5, {
          ptyAdapter,
          shellResolver: () => "/bin/sh",
        });
        const input = openInput();
        const failed = yield* manager.open(input);
        expect(failed.status).toBe("error");
        const spawnCount = ptyAdapter.spawnInputs.length;
        const eventsBefore = yield* getEvents;
        expect(yield* manager.snapshot(input)).toEqual(failed);
        expect(yield* manager.snapshot(input)).toEqual(failed);
        expect(failed).toMatchObject({ pid: null, exitCode: null, exitSignal: null });
        expect(ptyAdapter.spawnInputs).toHaveLength(spawnCount);
        expect(ptyAdapter.processes).toEqual([]);
        expect(yield* getEvents).toEqual(eventsBefore);
        expect(eventsBefore.some((event) => event.type === "exited")).toBe(false);
      }),
  );

  it.effect("reads a retained read-error without dropping ownership or synthesizing an exit", () =>
    Effect.gen(function* () {
      const ptyAdapter = new ErrorPtyAdapter();
      let released = 0;
      const { manager, getEvents } = yield* createManager(5, {
        ptyAdapter,
        releaseWorktreeLease: () =>
          Effect.sync(() => {
            released++;
          }),
      });
      const input = openInput();
      const opened = yield* manager.open(input);
      const process = ptyAdapter.processes[0]!;
      ptyAdapter.reportError(new Error("PTY read failed"));
      yield* waitFor(
        getEvents.pipe(Effect.map((events) => events.some((event) => event.type === "error"))),
      );
      const eventsBefore = yield* getEvents;
      const retained = yield* manager.snapshot(input);
      expect(retained).toMatchObject({
        status: "error",
        pid: process.pid,
        runtimeGeneration: opened.runtimeGeneration,
        exitCode: null,
        exitSignal: null,
      });
      expect(yield* manager.snapshot(input)).toEqual(retained);
      const closeError = yield* manager
        .close({ threadId: input.threadId, terminalId: input.terminalId, onlyIfNotRunning: true })
        .pipe(Effect.flip);
      expect(closeError._tag).toBe("TerminalExecutionTargetError");
      expect(released).toBe(0);
      expect(yield* getEvents).toEqual(eventsBefore);
      expect(eventsBefore.some((event) => event.type === "exited")).toBe(false);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(process.resizeCalls).toEqual([]);
      expect(process.killSignals).toEqual([]);
      expect(process.writes).toEqual([]);
    }),
  );
});
