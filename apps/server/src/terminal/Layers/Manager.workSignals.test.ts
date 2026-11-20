import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import type { TerminalFinishedCandidate } from "../activity/terminalWorkSignalReader.ts";
import { createManager, openInput, waitFor } from "./Manager.test.helpers";
import type { TerminalWorkSink } from "./Manager.workSignals.ts";

function recordingSink() {
  const submits: string[] = [];
  const finished: Array<{ terminalId: string; candidate: TerminalFinishedCandidate }> = [];
  const sink: TerminalWorkSink = {
    submit: (_threadId, terminalId) => Effect.sync(() => void submits.push(terminalId)),
    finished: (_threadId, terminalId, candidate) =>
      Effect.sync(() => void finished.push({ terminalId, candidate })),
  };
  return { sink, submits, finished };
}

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "TerminalManager work signals",
  (it) => {
    it.effect("reports Enter only for client writes", () =>
      Effect.gen(function* () {
        const recorded = recordingSink();
        const { manager } = yield* createManager(5, { workSink: recorded.sink });
        yield* manager.open(openInput());
        yield* manager.write({ threadId: "thread-1", data: "ls\r" });
        yield* manager.write({ threadId: "thread-1", data: "ls\r" }, { origin: "internal" });
        assert.deepEqual(recorded.submits, []);
        yield* manager.write({ threadId: "thread-1", data: "typing" }, { origin: "client" });
        assert.deepEqual(recorded.submits, []);
        yield* manager.write({ threadId: "thread-1", data: "\r" }, { origin: "client" });
        assert.deepEqual(recorded.submits, ["default"]);
      }),
    );

    it.effect("reports OSC 133 finished commands and agent markers from PTY output", () =>
      Effect.gen(function* () {
        const recorded = recordingSink();
        const { manager, ptyAdapter } = yield* createManager(5, { workSink: recorded.sink });
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.emitData("\u001b]133;C;cmdline_url=make\u0007building");
        process.emitData("\u001b]133;D;2\u0007$ ");
        process.emitData("\u001b]777;bigbud;done\u0007");
        yield* waitFor(
          Effect.sync(() => recorded.finished.length === 2),
          "1000 millis",
        );
        assert.equal(recorded.finished[0]!.candidate.command, "make");
        assert.equal(recorded.finished[0]!.candidate.exitCode, 2);
        assert.equal(recorded.finished[1]!.candidate.source, "agent-hook");
      }),
    );

    it.effect("falls back to the process poll only while no OSC 133 marker was seen", () =>
      Effect.gen(function* () {
        const recorded = recordingSink();
        let running = false;
        const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
          workSink: recorded.sink,
          subprocessChecker: () => Effect.succeed(running),
          subprocessPollIntervalMs: 20,
        });
        yield* manager.open(openInput());
        const cycle = (expectedFinished: number) =>
          Effect.gen(function* () {
            const before = (yield* getEvents).length;
            running = true;
            yield* waitFor(
              Effect.map(getEvents, (events) =>
                events.slice(before).some((e) => e.type === "activity" && e.hasRunningSubprocess),
              ),
              "1200 millis",
            );
            running = false;
            yield* waitFor(
              Effect.map(getEvents, (events) =>
                events.slice(before).some((e) => e.type === "activity" && !e.hasRunningSubprocess),
              ),
              "1200 millis",
            );
            yield* Effect.sleep("30 millis");
            assert.equal(recorded.finished.length, expectedFinished);
          });
        yield* cycle(1);
        assert.equal(recorded.finished[0]!.candidate.source, "process-poll");
        assert.isNull(recorded.finished[0]!.candidate.exitCode);
        ptyAdapter.processes[0]!.emitData("\u001b]133;A\u0007");
        yield* cycle(1);
      }),
    );

    it.effect("adds shell integration env only to local pane spawns", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellIntegrationEnv: () => ({ BIGBUD_SHELL_INTEGRATION_DIR: "/x" }),
        });
        yield* manager.open(openInput());
        const env = ptyAdapter.spawnInputs[0]!.env;
        assert.equal(
          env.BIGBUD_SHELL_INTEGRATION_DIR,
          process.platform === "win32" ? undefined : "/x",
        );
      }),
    );
  },
);
