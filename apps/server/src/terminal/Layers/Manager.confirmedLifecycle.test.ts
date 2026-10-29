import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { expect } from "vitest";
import { createManager, openInput, restartInput, waitFor } from "./Manager.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "confirmed terminal lifecycle",
  (it) => {
    it.effect(
      "close retains its session until exit and never KILLs a gracefully exited shell",
      () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 100 });
          const opened = yield* manager.open(openInput());
          const process = ptyAdapter.processes[0]!;
          process.exitOnSignal = null;
          process.paused = true;
          const closing = yield* manager
            .close({
              threadId: opened.threadId,
              terminalId: opened.terminalId,
              expectedGeneration: opened.runtimeGeneration,
            })
            .pipe(Effect.forkScoped);
          yield* waitFor(Effect.sync(() => process.killSignals.includes("SIGTERM")));
          expect(process.paused).toBe(false);
          expect(closing.pollUnsafe()).toBeUndefined();
          expect((yield* manager.snapshot(openInput())).pid).toBe(process.pid);
          process.emitExit({ exitCode: 0, signal: null });
          yield* Fiber.join(closing);
          expect(process.killSignals).toEqual(["SIGTERM"]);
        }),
    );

    it.effect(
      "restart waits for old exit and a repeated operation returns the same generation",
      () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 100 });
          const opened = yield* manager.open(openInput());
          const old = ptyAdapter.processes[0]!;
          old.exitOnSignal = null;
          const request = restartInput({
            expectedGeneration: opened.runtimeGeneration,
            operationId: "restart-1",
          });
          const restarting = yield* manager.restart(request).pipe(Effect.forkScoped);
          yield* waitFor(Effect.sync(() => old.killSignals.includes("SIGTERM")));
          expect(ptyAdapter.processes).toHaveLength(1);
          old.emitExit({ exitCode: 0, signal: null });
          const fresh = yield* Fiber.join(restarting);
          expect(fresh.runtimeGeneration).not.toBe(opened.runtimeGeneration);
          const retried = yield* manager.restart(request);
          expect(retried.runtimeGeneration).toBe(fresh.runtimeGeneration);
          expect(ptyAdapter.processes).toHaveLength(2);
          const staleClose = yield* manager
            .close({
              threadId: fresh.threadId,
              terminalId: fresh.terminalId,
              expectedGeneration: opened.runtimeGeneration,
            })
            .pipe(Effect.result);
          expect(staleClose._tag).toBe("Failure");
          const staleRestart = yield* manager
            .restart(
              restartInput({
                expectedGeneration: opened.runtimeGeneration,
                operationId: "another-request",
              }),
            )
            .pipe(Effect.result);
          expect(staleRestart._tag).toBe("Failure");
          const staleWrite = yield* manager
            .write({
              threadId: fresh.threadId,
              terminalId: fresh.terminalId,
              expectedGeneration: opened.runtimeGeneration,
              data: "old paste",
            })
            .pipe(Effect.result);
          expect(staleWrite._tag).toBe("Failure");
          expect(ptyAdapter.processes[1]!.killSignals).toEqual([]);
          expect(ptyAdapter.processes[1]!.writes).toEqual([]);
        }),
    );

    it.effect("unconfirmed stop fails without spawning or forgetting the original process", () =>
      Effect.gen(function* () {
        let released = 0;
        const { manager, ptyAdapter } = yield* createManager(5, {
          processKillGraceMs: 5,
          releaseWorktreeLease: () =>
            Effect.sync(() => {
              released++;
            }),
        });
        const opened = yield* manager.open(openInput());
        const old = ptyAdapter.processes[0]!;
        old.exitOnSignal = null;
        const result = yield* manager
          .restart(restartInput({ expectedGeneration: opened.runtimeGeneration }))
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(old.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(ptyAdapter.processes).toHaveLength(1);
        expect((yield* manager.snapshot(openInput())).pid).toBe(old.pid);
        expect(released).toBe(0);
        old.exitOnSignal = "SIGTERM";
        yield* manager.close({
          threadId: opened.threadId,
          terminalId: opened.terminalId,
          expectedGeneration: opened.runtimeGeneration,
        });
        expect(released).toBe(1);
      }),
    );

    it.effect(
      "preserves the previous transcript on failed replacement and clears it on success",
      () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter } = yield* createManager();
          yield* manager.open(openInput());
          ptyAdapter.processes[0]!.emitData("important failure context\n");
          yield* waitFor(
            Effect.map(manager.snapshot(openInput()), (snapshot) =>
              snapshot.history.includes("important"),
            ),
          );
          ptyAdapter.spawnFailures.push(new Error("native launch failed"));
          const failed = yield* manager.restart(restartInput({ operationId: "failed-spawn" }));
          expect(failed.status).toBe("error");
          expect(failed.history).toContain("important failure context");
          const fresh = yield* manager.restart(
            restartInput({
              expectedGeneration: failed.runtimeGeneration,
              operationId: "new-attempt",
            }),
          );
          expect(fresh.status).toBe("running");
          expect(fresh.history).toBe("");
        }),
    );

    it.effect("answers device queries without a mounted view and omits them from replay", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.emitData("before\u001b[>");
        process.emitData("0cafter\u001b[c");
        yield* waitFor(
          Effect.map(
            manager.snapshot(openInput()),
            (snapshot) => snapshot.history === "beforeafter",
          ),
        );
        expect(process.writes).toEqual(["\u001b[>0;276;0c", "\u001b[?1;2c"]);
        const output = (yield* getEvents)
          .filter((event) => event.type === "output")
          .map((event) => event.data)
          .join("");
        expect(output).toBe("beforeafter");
        yield* manager.snapshot(openInput());
        expect(process.writes).toHaveLength(2);
      }),
    );
  },
);
