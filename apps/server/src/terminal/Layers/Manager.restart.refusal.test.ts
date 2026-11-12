import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { createManager, openInput, restartInput } from "./Manager.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })("restart refusal boundary", (it) => {
  it.effect("profile refusal leaves the original generation and process usable", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const opened = yield* manager.open(openInput());
      const failed = yield* manager
        .restart(restartInput({ shellSelection: { kind: "profile", profileId: "missing" } }))
        .pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure") {
        expect(failed.failure).toMatchObject({
          _tag: "TerminalExecutionTargetError",
          reason: "restartNotStarted",
        });
      }
      const snapshot = yield* manager.snapshot(openInput());
      expect(snapshot).toEqual(opened);
      expect(ptyAdapter.processes[0]!.killSignals).toEqual([]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      yield* manager.write({
        threadId: opened.threadId,
        terminalId: opened.terminalId,
        expectedGeneration: opened.runtimeGeneration,
        data: "still-editable",
      });
      expect(ptyAdapter.processes[0]!.writes).toEqual(["still-editable"]);
    }),
  );

  it.effect("shutdown errors never carry preflight refusal evidence", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const originalKill = process.kill.bind(process);
      process.kill = () => {
        throw new Error("shutdown transport unknown");
      };
      const failed = yield* manager.restart(restartInput()).pipe(Effect.result);
      // Restore cleanup independently of the assertion outcome.
      process.kill = originalKill;
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure") {
        expect(failed.failure._tag).toBe("TerminalExecutionTargetError");
        expect(failed.failure).not.toHaveProperty("reason", "restartNotStarted");
      }
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("a post-stop spawn failure reports an error snapshot, not safe refusal", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const opened = yield* manager.open(openInput());
      ptyAdapter.spawnFailures.push(new Error("exec failed"));
      const failed = yield* manager.restart(restartInput());
      expect(failed.status).toBe("error");
      expect(failed.runtimeGeneration).not.toBe(opened.runtimeGeneration);
      expect(ptyAdapter.processes[0]!.killSignals).toEqual(["SIGTERM"]);
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThan(1);
      expect(failed).not.toHaveProperty("reason", "restartNotStarted");
    }),
  );
});
