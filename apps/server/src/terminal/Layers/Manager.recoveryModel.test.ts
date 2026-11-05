import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { TerminalRecoveryModel } from "./TerminalRecoveryModel";
import {
  createManager,
  openInput,
  waitFor,
  FakePtyProcess,
  FakePtyAdapter,
} from "./Manager.test.helpers";

beforeEach(() => vi.stubEnv("BIGBUD_TERMINAL_RECOVERY_SHADOW", "1"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.layer(NodeServices.layer, { excludeTestServices: true })("manager shadow ownership", (it) => {
  it.effect("captures synchronous first-listener output before startup completes", () =>
    Effect.gen(function* () {
      const original = FakePtyProcess.prototype.onData;
      vi.spyOn(FakePtyProcess.prototype, "onData").mockImplementation(
        function (this: FakePtyProcess, callback) {
          callback("first-byte");
          return original.call(this, callback);
        },
      );
      const writes = vi.spyOn(TerminalRecoveryModel.prototype, "write");
      const { manager } = yield* createManager();
      yield* manager.open(openInput());
      const model = writes.mock.contexts[0];
      if (!(model instanceof TerminalRecoveryModel)) throw new Error("Missing startup model");
      const snapshot = yield* Effect.promise(() => model.capture());
      expect(snapshot.type === "candidate" && snapshot.frame.ansi).toContain("first-byte");
    }),
  );

  it.effect("never invents a baseline for an adopted remote owner", () =>
    Effect.gen(function* () {
      const adapter = new FakePtyAdapter();
      const original = adapter.spawn.bind(adapter);
      vi.spyOn(adapter, "spawn").mockImplementation((input) =>
        original(input).pipe(Effect.map((process) => Object.assign(process, { recovered: true }))),
      );
      const writes = vi.spyOn(TerminalRecoveryModel.prototype, "write");
      const { manager } = yield* createManager(5, { ptyAdapter: adapter });
      const snapshot = yield* manager.open(openInput());
      adapter.processes[0]!.emitData("unknown prefix");
      expect(snapshot.historyUnavailable).toBe(true);
      expect(writes).not.toHaveBeenCalled();
    }),
  );
  it.effect(
    "feeds the live generation, orders both resize paths and disposes on explicit restart/close",
    () =>
      Effect.gen(function* () {
        const writes = vi.spyOn(TerminalRecoveryModel.prototype, "write");
        const { manager, ptyAdapter, getEvents } = yield* createManager();
        const input = openInput();
        const initial = yield* manager.open(input);
        const process = ptyAdapter.processes[0]!;
        process.emitData("first\x1b[6n");
        yield* waitFor(
          Effect.map(getEvents, (events) => events.some((event) => event.type === "output")),
        );
        const model = writes.mock.contexts[0]!;
        if (!(model instanceof TerminalRecoveryModel)) throw new Error("Missing live model");
        model.observeInput("\x1b[1;6R"); // Simulated live renderer, never a headless reply sink.
        yield* manager.resize({ ...input, cols: 90, rows: 30 });
        yield* manager.open({ ...input, cols: 100, rows: 35 });
        process.emitData("tail");
        const capture = yield* Effect.promise(() => model.capture());
        expect(capture.type).toBe("candidate");
        if (capture.type === "candidate") {
          expect(capture.frame).toMatchObject({
            generation: initial.runtimeGeneration,
            cols: 100,
            rows: 35,
          });
          expect(capture.frame.ansi).toContain("firsttail");
        }
        expect(process.writes).toEqual([]); // Mirror's DSR response must never reach the PTY.
        const cut = model.records.cursor;
        vi.spyOn(process, "resize").mockImplementationOnce(() =>
          process.emitData("synchronous-resize-output"),
        );
        yield* manager.resize({ ...input, cols: 110, rows: 36 });
        yield* Effect.promise(() => model.capture());
        const suffix = model.records.after(cut);
        expect(suffix.type === "suffix" && suffix.records.map((record) => record.type)).toEqual([
          "resize",
          "output",
        ]);
        process.throwOnResize = true;
        yield* manager.resize({ ...input, cols: 120, rows: 40 }).pipe(Effect.result);
        const unchanged = yield* Effect.promise(() => model.capture());
        expect(unchanged.type === "candidate" && unchanged.frame.cols).toBe(110);
        process.throwOnResize = false;
        const next = yield* manager.restart({ ...input, cols: 80, rows: 24 });
        expect(next.runtimeGeneration).not.toBe(initial.runtimeGeneration);
        expect(model.unavailableReason).not.toBeNull();
        ptyAdapter.processes[1]!.emitData("new");
        const replacement = writes.mock.contexts.at(-1)!;
        if (!(replacement instanceof TerminalRecoveryModel))
          throw new Error("Missing replacement model");
        expect(replacement).not.toBe(model);
        yield* manager.close(input);
        expect(replacement.unavailableReason).not.toBeNull();
      }),
  );
});
