import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { createManager, openInput, waitFor } from "./Manager.test.helpers.ts";
import { TerminalSubprocessCheckError } from "./Manager.shell.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "terminal idle work without a renderer",
  (it) => {
    it.effect("polls silent background work, survives failure, and records completion/close", () =>
      Effect.gen(function* () {
        let busy = false;
        let fails = false;
        let scans = 0;
        const { manager, ptyAdapter } = yield* createManager(5, {
          subprocessPollIntervalMs: 20,
          subprocessChecker: (terminalPid) => {
            scans++;
            return fails
              ? Effect.fail(
                  new TerminalSubprocessCheckError({
                    message: "unknown",
                    terminalPid,
                    command: "ps",
                  }),
                )
              : Effect.succeed(busy);
          },
        });
        const input = openInput();
        yield* manager.open(input);
        const facts = manager.getThreadIdleWork!(input.threadId);
        expect((yield* facts).state).toBe("unknown");
        yield* waitFor(facts.pipe(Effect.map((work) => work.state === "idle")), "1200 millis");
        busy = true;
        yield* waitFor(facts.pipe(Effect.map((work) => work.state === "busy")), "1200 millis");
        const beforeFailure = scans;
        fails = true;
        yield* waitFor(
          Effect.sync(() => scans > beforeFailure + 1),
          "1200 millis",
        );
        expect((yield* facts).state).toBe("busy");
        fails = false;
        busy = false;
        yield* waitFor(facts.pipe(Effect.map((work) => work.state === "idle")), "1200 millis");
        const completion = (yield* facts).quietSince;
        expect(completion).not.toBeNull();
        yield* manager.close({ threadId: input.threadId });
        expect((yield* facts).quietSince).toBe(completion);
        // No output, active viewport, or renderer subscription was needed for these facts.
        expect(ptyAdapter.processes[0]!.writes).toEqual([]);
      }),
    );

    it.effect("releases work on confirmed natural exit and keeps the barrier after eviction", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          subprocessPollIntervalMs: 20,
          maxRetainedInactiveSessions: 0,
          subprocessChecker: () => Effect.succeed(true),
        });
        const input = openInput();
        yield* manager.open(input);
        const facts = manager.getThreadIdleWork!(input.threadId);
        yield* waitFor(facts.pipe(Effect.map((work) => work.state === "busy")), "1200 millis");
        ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: null });
        yield* waitFor(facts.pipe(Effect.map((work) => work.state === "idle")), "1200 millis");
        expect((yield* facts).quietSince).not.toBeNull();
      }),
    );

    it.effect("an inspection failure after an idle observation becomes unknown, not idle", () =>
      Effect.gen(function* () {
        let fails = false;
        const { manager } = yield* createManager(5, {
          subprocessPollIntervalMs: 20,
          subprocessChecker: (terminalPid) =>
            fails
              ? Effect.fail(
                  new TerminalSubprocessCheckError({
                    message: "unknown",
                    terminalPid,
                    command: "ps",
                  }),
                )
              : Effect.succeed(false),
        });
        const input = openInput();
        yield* manager.open(input);
        const facts = manager.getThreadIdleWork!(input.threadId);
        yield* waitFor(facts.pipe(Effect.map((work) => work.state === "idle")), "1200 millis");
        fails = true;
        yield* waitFor(facts.pipe(Effect.map((work) => work.state === "unknown")), "1200 millis");
        fails = false;
        yield* waitFor(facts.pipe(Effect.map((work) => work.state === "idle")), "1200 millis");
        expect((yield* facts).quietSince).not.toBeNull();
      }),
    );
  },
);
