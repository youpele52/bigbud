import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { createManager, openInput, waitFor } from "./Manager.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })("view-only terminal recovery", (it) => {
  it.effect("refuses missing and exited processes without invoking spawn or resize", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();
      const input = openInput();
      expect((yield* Effect.result(manager.snapshot(input)))._tag).toBe("Failure");
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
      const opened = yield* manager.open(input);
      const recovered = yield* manager.snapshot(input);
      expect(recovered.pid).toBe(opened.pid);
      const process = ptyAdapter.processes[0]!;
      expect(process.resizeCalls).toHaveLength(0);
      process.emitExit({ exitCode: 0, signal: 0 });
      yield* waitFor(
        getEvents.pipe(Effect.map((events) => events.some((event) => event.type === "exited"))),
      );
      expect((yield* Effect.result(manager.snapshot(input)))._tag).toBe("Failure");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(process.resizeCalls).toHaveLength(0);
    }),
  );
});
