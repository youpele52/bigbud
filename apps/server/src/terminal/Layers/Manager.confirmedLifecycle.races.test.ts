import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { createManager, openInput, restartInput, waitFor } from "./Manager.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })("confirmed lifecycle races", (it) => {
  it.effect("keeps the replacement discoverable even with zero inactive retention", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        maxRetainedInactiveSessions: 0,
      });
      const opened = yield* manager.open(openInput());
      const restarted = yield* manager.restart(
        restartInput({ expectedGeneration: opened.runtimeGeneration, operationId: "retained" }),
      );
      expect(restarted.pid).toBe(ptyAdapter.processes[1]!.pid);
      expect((yield* manager.snapshot(openInput())).runtimeGeneration).toBe(
        restarted.runtimeGeneration,
      );
      yield* manager.close({ ...openInput(), expectedGeneration: restarted.runtimeGeneration });
      expect(ptyAdapter.processes[1]!.killSignals).toEqual(["SIGTERM"]);
    }),
  );

  it.effect("accepts an exit observed before the shutdown listener could subscribe", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const opened = yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const original = process.onExit.bind(process);
      process.exitOnSignal = null;
      const subscribe = vi.spyOn(process, "onExit").mockImplementation((listener) => {
        process.emitExit({ exitCode: 0, signal: null });
        return original(listener);
      });
      yield* manager.close({ ...openInput(), expectedGeneration: opened.runtimeGeneration });
      expect(process.killSignals).toEqual([]);
      subscribe.mockRestore();
    }),
  );

  it.effect("keeps ownership after signal failure and allows a successful retry", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const opened = yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      yield* manager.setOutputHold!({
        threadId: opened.threadId,
        terminalId: opened.terminalId,
        holderId: "slow-view",
        held: true,
      });
      expect(process.paused).toBe(true);
      const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
        throw new Error("EPERM: cannot signal process");
      });
      const request = { ...openInput(), expectedGeneration: opened.runtimeGeneration };
      expect((yield* manager.close(request).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* manager.snapshot(openInput())).pid).toBe(process.pid);
      expect(process.paused).toBe(true);
      yield* manager.close(request);
      expect(kill).toHaveBeenCalledTimes(2);
      kill.mockRestore();
    }),
  );
  it.effect("delivers a final incomplete escape sequence before the exit event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.emitData("last output\u001b[3");
      process.emitExit({ exitCode: 0, signal: null });
      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const events = yield* getEvents;
      expect(
        events
          .filter((event) => event.type === "output")
          .map((event) => event.data)
          .join(""),
      ).toBe("last output\u001b[3");
      expect(events.at(-1)?.type).toBe("exited");
    }),
  );
});
