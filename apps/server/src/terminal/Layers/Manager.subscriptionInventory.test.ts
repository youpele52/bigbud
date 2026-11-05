import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Option, Queue } from "effect";
import type * as Cause from "effect/Cause";
import { expect } from "vitest";
import type { TerminalEvent } from "@bigbud/contracts";
import type { TerminalEventsStreamItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { subscribeToTerminalEvents } from "./Manager.session.subscription";
import { createTerminalSessionState } from "./Manager.session.state";
import type { TerminalManagerState } from "./Manager.types";
import { createManager, openInput, waitFor } from "./Manager.test.helpers";
import { makeBoundedTerminalEventOffer } from "../../ws/wsRpcHandlers.terminalEvents";

it.effect(
  "captures inventory with registration and buffers live events behind inventory/replay",
  () =>
    Effect.gen(function* () {
      const session = createTerminalSessionState({
        threadId: "thread",
        terminalId: "wsl",
        executionTargetId: "wsl:Ubuntu",
        dropPathMode: "posix",
        cwd: "/work",
        worktreePath: null,
        history: "large history",
        cols: 80,
        rows: 24,
        runtimeEnv: null,
      });
      session.status = "running";
      const state: TerminalManagerState = {
        sessions: new Map([["wsl", session]]),
        killFibers: new Map(),
      };
      const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
      const items: TerminalEventsStreamItem[] = [];
      const live: TerminalEvent = {
        type: "activity",
        threadId: "thread",
        terminalId: "wsl",
        createdAt: new Date().toISOString(),
        hasRunningSubprocess: true,
      };
      const stop = yield* subscribeToTerminalEvents(
        {
          modifyManagerState: (f) => Effect.sync(() => f(state)[0]),
          getSession: () => Effect.succeed(Option.some(session)),
          terminalEventListeners: listeners,
        },
        (event) =>
          Effect.sync(() => {
            items.push(event);
          }),
        {
          outputScope: "legacyDetection",
          onInventory: (inventory) =>
            Effect.gen(function* () {
              items.push(inventory);
              // A real publication can arrive while the inventory callback yields to transport delivery.
              state.sessions.clear();
              for (const listener of listeners) yield* listener(live);
            }),
        },
      );
      expect(items).toEqual([
        expect.objectContaining({
          type: "inventory",
          sessions: [{ threadId: "thread", terminalId: "wsl" }],
        }),
        live,
      ]);
      expect(JSON.stringify(items[0])).not.toContain("large history");
      stop();
      expect(listeners.size).toBe(0);
    }),
);

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "inventory after lost termination",
  (it) => {
    for (const stopped of ["exited", "error", "deleted"] as const) {
      it.effect(`reconciles absence after overflow then ${stopped} session removal`, () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
            maxRetainedInactiveSessions: 0,
          });
          if (stopped === "error") ptyAdapter.spawnFailures.push(new Error("spawn failed"));
          yield* manager.open(openInput());
          const queue = yield* Queue.make<TerminalEventsStreamItem, Cause.Done>();
          const offer = makeBoundedTerminalEventOffer(queue, {
            chars: 10,
            items: 1,
            totalItems: 1,
          });
          const stop = yield* manager.subscribe(offer, {
            outputScope: "legacyDetection",
            onInventory: offer,
          });
          // Fill the stalled subscriber even when the failed session was already evicted on spawn.
          yield* offer({ type: "inventory", createdAt: new Date().toISOString(), sessions: [] });
          if (stopped === "exited") {
            ptyAdapter.processes[0]!.emitExit({ exitCode: 7, signal: null });
            yield* waitFor(
              getEvents.pipe(
                Effect.map((events) => events.some((event) => event.type === "exited")),
              ),
            );
            // Eviction is just after the emitted exit.
            yield* Effect.yieldNow;
          } else if (stopped === "deleted") {
            yield* manager.close({
              threadId: "thread-1",
              terminalId: "default",
              deleteHistory: true,
            });
          }
          stop();
          expect(Queue.sizeUnsafe(queue)).toBe(0);
          expect((yield* Queue.take(queue).pipe(Effect.result))._tag).toBe("Failure");
          const items: TerminalEventsStreamItem[] = [];
          const deliver = (item: TerminalEventsStreamItem) =>
            Effect.sync(() => {
              items.push(item);
            });
          const resubscribe = yield* manager.subscribe(deliver, {
            outputScope: "legacyDetection",
            onInventory: deliver,
          });
          expect(items).toEqual([expect.objectContaining({ type: "inventory", sessions: [] })]);
          expect(ptyAdapter.spawnInputs).toHaveLength(1);
          if (stopped === "exited") expect(ptyAdapter.processes[0]!.killSignals).toEqual([]);
          resubscribe();
        }),
      );
    }
  },
);
