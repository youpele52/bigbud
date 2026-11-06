import { type OrchestrationCommand, type OrchestrationEvent, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { PendingThreadSnooze } from "../../persistence/Services/ProjectionThreads.ts";
import { startThreadSnoozeDelivery } from "./ThreadOrganizationReactor.snooze.fixture.ts";

const threadA = ThreadId.makeUnsafe("thread-a");
const threadB = ThreadId.makeUnsafe("thread-b");
const at = (ms: number) => new Date(ms).toISOString();
const snoozed = (threadId: ThreadId, snoozeId: string, untilMs: number) =>
  ({
    type: "thread.organization-updated",
    payload: {
      threadId,
      reason: "snooze",
      organization: {
        state: "later",
        revision: 1,
        changedAt: at(0),
        snooze: { id: snoozeId, until: at(untilMs) },
      },
    },
  }) as unknown as OrchestrationEvent;
const moved = (threadId: ThreadId) =>
  ({
    type: "thread.organization-updated",
    payload: {
      threadId,
      reason: "move",
      organization: { state: "done", revision: 2, changedAt: at(0), snooze: null },
    },
  }) as unknown as OrchestrationEvent;

const harness = (input: {
  readonly rows?: ReadonlyArray<PendingThreadSnooze>;
  readonly failures?: number;
}) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const attempts = yield* Ref.make(0);
    const rows = yield* Ref.make(input.rows ?? []);
    yield* startThreadSnoozeDelivery({
      orchestrationEngine: {
        streamDomainEvents: Stream.fromQueue(events),
        dispatch: (command) =>
          Effect.gen(function* () {
            const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
            if (attempt <= (input.failures ?? 0))
              return yield* Effect.fail(new Error("busy") as never);
            yield* Ref.update(dispatched, (all) => [...all, command]);
            // Like the projection: a delivered snooze is no longer pending.
            if (command.type === "thread.organization.snooze.expire") {
              yield* Ref.update(rows, (all) =>
                all.filter((row) => row.snoozeId !== command.snoozeId),
              );
            }
            return { sequence: attempt };
          }),
      },
      threadRepository: {
        // Pages like the SQL keyset query: ordered by (until, threadId), after the cursor.
        listPendingSnoozes: (query) =>
          Ref.get(rows).pipe(
            Effect.map((all) => {
              const sorted = [...all].toSorted((left, right) =>
                left.until === right.until
                  ? left.threadId.localeCompare(right.threadId)
                  : left.until.localeCompare(right.until),
              );
              const after = query.after;
              const remaining =
                after === undefined
                  ? sorted
                  : sorted.filter(
                      (row) =>
                        row.until > after.until ||
                        (row.until === after.until && row.threadId > after.threadId),
                    );
              return remaining.slice(0, query.limit);
            }),
          ),
      },
    });
    const settle = Effect.gen(function* () {
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
    });
    return { events, dispatched, attempts, rows, settle };
  });

const expiries = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) =>
    command.type === "thread.organization.snooze.expire"
      ? [command.threadId, command.snoozeId]
      : [command.type],
  );

it.effect("delivers a snooze at its deadline, not before", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, dispatched, settle } = yield* harness({});
      yield* Queue.offer(events, snoozed(threadA, "s-1", 120_000));
      yield* settle;
      yield* TestClock.adjust("119999 millis");
      yield* settle;
      assert.deepEqual(yield* Ref.get(dispatched), []);
      yield* TestClock.adjust("1 millis");
      yield* settle;
      assert.deepEqual(expiries(yield* Ref.get(dispatched)), [[threadA, "s-1"]]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a move or re-snooze replaces the pending timer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, dispatched, settle } = yield* harness({});
      yield* Queue.offer(events, snoozed(threadA, "s-1", 5_000));
      yield* Queue.offer(events, snoozed(threadB, "s-2", 5_000));
      yield* settle;
      yield* Queue.offer(events, moved(threadA));
      yield* Queue.offer(events, snoozed(threadB, "s-3", 8_000));
      yield* settle;
      yield* TestClock.adjust("6 seconds");
      yield* settle;
      assert.deepEqual(yield* Ref.get(dispatched), []);
      yield* TestClock.adjust("2 seconds");
      yield* settle;
      assert.deepEqual(expiries(yield* Ref.get(dispatched)), [[threadB, "s-3"]]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("recovers at start: overdue snoozes now, future ones at their deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(60_000);
      const { dispatched, settle } = yield* harness({
        rows: [
          { threadId: threadA, snoozeId: "s-overdue", until: at(30_000) },
          { threadId: threadB, snoozeId: "s-future", until: at(90_000) },
        ],
      });
      yield* settle;
      assert.deepEqual(expiries(yield* Ref.get(dispatched)), [[threadA, "s-overdue"]]);
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      assert.deepEqual(expiries(yield* Ref.get(dispatched)), [
        [threadA, "s-overdue"],
        [threadB, "s-future"],
      ]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("pages past a full batch and retries failed delivery on the next sweep", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const rows = Array.from({ length: 101 }, (_, index) => ({
        threadId: ThreadId.makeUnsafe(`thread-${String(index).padStart(3, "0")}`),
        snoozeId: `s-${index}`,
        until: at(500_000),
      }));
      // The first delivery exhausts its retries (1 attempt + 3 retries) and is left to the sweep.
      const { dispatched, settle } = yield* harness({ rows, failures: 4 });
      yield* settle;
      yield* TestClock.adjust("2 seconds");
      yield* settle;
      assert.equal((yield* Ref.get(dispatched)).length, 100);
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      const commands = yield* Ref.get(dispatched);
      assert.equal(commands.length, 101);
      assert.deepEqual(expiries(commands.slice(-1)), [[rows[0]!.threadId, "s-0"]]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);
