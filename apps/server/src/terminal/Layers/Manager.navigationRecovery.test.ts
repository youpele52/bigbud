import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";

import { TERMINAL_HISTORY_BYTE_LIMIT } from "./Manager.history.retention";
import { createManager, openInput, waitFor } from "./Manager.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "terminal navigation recovery",
  (it) => {
    for (const exhausted of [false, true]) {
      it.effect(
        `reattaches the same process after four other threads (history exhausted=${exhausted})`,
        () =>
          Effect.gen(function* () {
            const { manager, ptyAdapter, getEvents } = yield* createManager(5000, {
              maxRetainedInactiveSessions: 0,
            });
            const input = openInput();
            const initial = yield* manager.open(input);
            const process = ptyAdapter.processes[0]!;
            const unsubscribe = yield* manager.subscribe(() => Effect.void);

            // A full-screen TUI can exhaust byte retention without producing newlines.
            const output = exhausted
              ? "\x1b[H\x1b[2JPi " + "x".repeat(TERMINAL_HISTORY_BYTE_LIMIT)
              : "\x1b[H\x1b[2JPi ready";
            process.emitData(output);
            yield* waitFor(
              Effect.map(getEvents, (events) =>
                events.some((event) => event.type === "output" && event.data === output),
              ),
            );
            unsubscribe();

            for (let index = 0; index < 4; index++) {
              yield* manager.open(openInput({ threadId: `other-${index}` }));
            }
            const reattached = yield* manager.open(input);
            const snapshot = yield* manager.snapshot(input);

            for (const state of [reattached, snapshot]) {
              expect(state.status).toBe("running");
              expect(state.pid).toBe(initial.pid);
              expect(Boolean(state.historyTruncated)).toBe(exhausted);
              expect(state.history).toBe(exhausted ? "" : output);
            }
            expect(ptyAdapter.spawnInputs).toHaveLength(5);
            expect(process.killSignals).toEqual([]);
            // Backend input remains usable; an exhausted baseline blocks only fresh-view hydration.
            yield* manager.write({ ...input, data: "hello\r" });
            expect(process.writes).toContain("hello\r");
            expect((yield* getEvents).some((event) => event.type === "exited")).toBe(false);
          }),
      );
    }
  },
);
