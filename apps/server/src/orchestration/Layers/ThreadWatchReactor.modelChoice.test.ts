import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ThreadId,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { requestedPayload } from "../deciderThreads.delegationModelChoice.test.helpers.ts";
import { startDelegatedModelChoiceSupervision } from "./ThreadWatchReactor.modelChoice.ts";

const threadId = ThreadId.makeUnsafe("child-thread");
const deadlineAt = (ms: number) => new Date(ms).toISOString();
const payload = (choiceId: string, deadlineMs: number) => ({
  ...requestedPayload,
  choiceId,
  deadlineAt: deadlineAt(deadlineMs),
});
const activityEvent = (kind: string, activityPayload: unknown) =>
  ({
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: EventId.makeUnsafe(`${kind}-activity`),
        tone: "info",
        kind,
        summary: kind,
        payload: activityPayload,
        turnId: null,
        createdAt: deadlineAt(0),
      },
    },
  }) as unknown as OrchestrationEvent;

const harness = (input: {
  readonly rows?: ReadonlyArray<{ readonly threadId: ThreadId; readonly payload: unknown }>;
  readonly failures?: number;
}) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const attempts = yield* Ref.make(0);
    const rows = yield* Ref.make(input.rows ?? []);
    const queries = yield* Ref.make<ReadonlyArray<{ after?: unknown }>>([]);
    yield* startDelegatedModelChoiceSupervision({
      orchestrationEngine: {
        streamDomainEvents: Stream.fromQueue(events),
        dispatch: (command) =>
          Effect.gen(function* () {
            const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
            if (attempt <= (input.failures ?? 0))
              return yield* Effect.fail(new Error("busy") as never);
            yield* Ref.update(dispatched, (all) => [...all, command]);
            return { sequence: attempt };
          }),
      },
      activityRepository: {
        // Pages like the SQL keyset query: ordered by (createdAt, activityId), after the cursor.
        listPendingDelegatedModelChoiceRequests: (query) =>
          Effect.gen(function* () {
            yield* Ref.update(queries, (all) => [...all, query]);
            const all = (yield* Ref.get(rows)).map((row, index) => ({
              threadId: row.threadId,
              payload: row.payload,
              activityId: EventId.makeUnsafe(`row-${String(index).padStart(4, "0")}`),
              createdAt: deadlineAt(0),
            }));
            const start =
              query.after === undefined
                ? 0
                : all.findIndex((row) => row.activityId === query.after?.activityId) + 1;
            return all.slice(start, start + query.limit);
          }),
      },
    });
    const settle = Effect.gen(function* () {
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
    });
    return { events, dispatched, attempts, rows, queries, settle };
  });

const expireOf = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) =>
    command.type === "thread.delegation.model-choice.expire"
      ? [command.choiceId, command.resolvedBy]
      : [command.type],
  );

it.effect("expires a requested choice at its deadline with the stable timer command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, dispatched, settle } = yield* harness({});
      yield* Queue.offer(
        events,
        activityEvent("delegation.model-choice-requested", payload("c-1", 10_000)),
      );
      yield* settle;
      yield* TestClock.adjust("9999 millis");
      yield* settle;
      assert.deepEqual(yield* Ref.get(dispatched), []);
      yield* TestClock.adjust("1 millis");
      yield* settle;
      const commands = yield* Ref.get(dispatched);
      assert.deepEqual(expireOf(commands), [["c-1", "timeout"]]);
      assert.equal(commands[0]?.commandId, "model-choice-expire:c-1");
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("cancels the timer when the choice resolves first and clamps far deadlines", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, dispatched, settle } = yield* harness({});
      yield* Queue.offer(
        events,
        activityEvent("delegation.model-choice-requested", payload("c-1", 5_000)),
      );
      yield* Queue.offer(
        events,
        activityEvent("delegation.model-choice-requested", payload("c-2", 999_999)),
      );
      yield* settle;
      yield* Queue.offer(
        events,
        activityEvent("delegation.model-choice-resolved", { choiceId: "c-1" }),
      );
      yield* settle;
      yield* TestClock.adjust("10 seconds");
      yield* settle;
      assert.deepEqual(expireOf(yield* Ref.get(dispatched)), [["c-2", "timeout"]]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("sweeps at start and every 30 s: past deadlines now, future ones at the deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.adjust("20 seconds");
      const { dispatched, rows, settle } = yield* harness({
        rows: [
          { threadId, payload: payload("past", 15_000) },
          { threadId, payload: payload("future", 25_000) },
          { threadId, payload: { malformed: true } },
        ],
      });
      yield* settle;
      assert.deepEqual(expireOf(yield* Ref.get(dispatched)), [["past", "restart-sweep"]]);
      yield* Ref.set(rows, [{ threadId, payload: payload("future", 25_000) }]);
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      assert.deepEqual(expireOf(yield* Ref.get(dispatched)).at(-1), ["future", "timeout"]);
      yield* Ref.set(rows, [{ threadId, payload: payload("missed", 1_000) }]);
      yield* TestClock.adjust("25 seconds");
      yield* settle;
      assert.deepEqual(expireOf(yield* Ref.get(dispatched)).at(-1), ["missed", "restart-sweep"]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("retries a failed expiry three times with backoff, then leaves it to the sweep", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, dispatched, attempts, settle } = yield* harness({ failures: 3 });
      yield* Queue.offer(
        events,
        activityEvent("delegation.model-choice-requested", payload("c-1", 0)),
      );
      yield* settle;
      for (let step = 0; step < 4; step += 1) {
        yield* TestClock.adjust("2 seconds");
        yield* settle;
      }
      assert.equal(yield* Ref.get(attempts), 4);
      assert.deepEqual(expireOf(yield* Ref.get(dispatched)), [["c-1", "timeout"]]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("pages through every pending row in one sweep, with no age cutoff (M4)", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.adjust("20 seconds");
      const { dispatched, queries, settle } = yield* harness({
        rows: Array.from({ length: 150 }, (_, index) => ({
          threadId,
          payload: payload(`stuck-${index}`, 1_000),
        })),
      });
      yield* settle;
      assert.equal((yield* Ref.get(dispatched)).length, 150);
      const seen = yield* Ref.get(queries);
      assert.isAbove(seen.length, 1);
      assert.isUndefined(seen[0]?.after);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);
