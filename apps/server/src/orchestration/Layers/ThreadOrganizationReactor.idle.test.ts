import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type ServerSettings,
  ThreadId,
} from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import type {
  IdleThreadCandidate,
  ListIdleThreadCandidatesInput,
} from "../../persistence/Services/ProjectionThreads.ts";
import { idleBarrierAfterTick, startThreadIdleCleanup } from "./ThreadOrganizationReactor.idle.ts";

const threadA = ThreadId.makeUnsafe("thread-a");
const MINUTE = 60_000;
const enabled: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  itutuIdleCleanupEnabled: true,
  itutuIdleTimeoutMinutes: 10,
};

const harness = (initial: ServerSettings) =>
  Effect.gen(function* () {
    const settings = yield* Ref.make(initial);
    const changes = yield* Queue.unbounded<ServerSettings>();
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const queries = yield* Ref.make<ReadonlyArray<ListIdleThreadCandidatesInput>>([]);
    const candidates = yield* Ref.make<ReadonlyArray<IdleThreadCandidate>>([
      { threadId: threadA, revision: 3, activityAt: new Date(0).toISOString() },
    ]);
    yield* startThreadIdleCleanup({
      orchestrationEngine: {
        dispatch: (command) =>
          Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 })),
      },
      threadRepository: {
        listIdleCandidates: (query) =>
          Ref.update(queries, (all) => [...all, query]).pipe(Effect.andThen(Ref.get(candidates))),
      },
      settings: { getSettings: Ref.get(settings), streamChanges: Stream.fromQueue(changes) },
    });
    const settle = Effect.gen(function* () {
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
    });
    const change = (next: ServerSettings) =>
      Ref.set(settings, next).pipe(
        Effect.andThen(Queue.offer(changes, next)),
        Effect.andThen(settle),
      );
    const advance = (ms: number) =>
      Effect.gen(function* () {
        // Step like a running process, so the loop sees no false sleep gap.
        for (let remaining = ms; remaining > 0; remaining -= 15_000) {
          yield* TestClock.adjust(`${Math.min(remaining, 15_000)} millis`);
          yield* settle;
        }
      });
    return { dispatched, queries, candidates, change, advance, settle };
  });

const moves = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) =>
    command.type === "thread.organization.idle"
      ? [command.threadId, command.expectedRevision, command.destination]
      : [command.type],
  );

it.effect("stays off until enabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dispatched, queries, advance } = yield* harness(DEFAULT_SERVER_SETTINGS);
      yield* advance(30 * MINUTE);
      assert.deepEqual(yield* Ref.get(dispatched), []);
      assert.deepEqual(yield* Ref.get(queries), []);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("waits a full timeout after start, then moves with the revision fence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dispatched, queries, advance } = yield* harness(enabled);
      yield* advance(9 * MINUTE + 45_000);
      assert.deepEqual(yield* Ref.get(dispatched), []);
      yield* advance(15_000);
      assert.deepEqual(moves(yield* Ref.get(dispatched)), [[threadA, 3, "done"]]);
      const [query] = yield* Ref.get(queries);
      assert.equal(query?.cutoff, new Date(0).toISOString());
      // A declined candidate is not retried at the same revision for a minute.
      yield* advance(45_000);
      assert.equal((yield* Ref.get(dispatched)).length, 1);
      yield* advance(15_000);
      assert.equal((yield* Ref.get(dispatched)).length, 2);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a policy change restarts the wait and uses the new destination", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dispatched, change, advance } = yield* harness(enabled);
      yield* advance(8 * MINUTE);
      yield* change({ ...enabled, itutuIdleDestination: "later", itutuIdleTimeoutMinutes: 5 });
      yield* advance(4 * MINUTE + 45_000);
      assert.deepEqual(yield* Ref.get(dispatched), []);
      yield* advance(15_000);
      assert.deepEqual(moves(yield* Ref.get(dispatched)), [[threadA, 3, "later"]]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

describe("idleBarrierAfterTick", () => {
  it("restarts the wait after a pause much longer than the sweep interval", () => {
    const barrierMs = 1_000;
    assert.equal(
      idleBarrierAfterTick({ barrierMs, previousTickMs: 100_000, nowMs: 115_000 }),
      barrierMs,
    );
    assert.equal(
      idleBarrierAfterTick({ barrierMs, previousTickMs: 100_000, nowMs: 175_000 }),
      barrierMs,
    );
    assert.equal(
      idleBarrierAfterTick({ barrierMs, previousTickMs: 100_000, nowMs: 175_001 }),
      175_001,
    );
  });
});
