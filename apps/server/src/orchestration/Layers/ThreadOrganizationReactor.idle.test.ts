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
const DAY = 24 * 60 * MINUTE;
const off: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  itutuIdleCleanupEnabled: false,
  itutuOlderThreadsEnabled: false,
};
const candidate = (state: IdleThreadCandidate["state"]): IdleThreadCandidate => ({
  threadId: threadA,
  state,
  revision: 3,
  activityAt: new Date(0).toISOString(),
});

const harness = (initial: ServerSettings, state: IdleThreadCandidate["state"] = "present") =>
  Effect.gen(function* () {
    const settings = yield* Ref.make(initial);
    const changes = yield* Queue.unbounded<ServerSettings>();
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const queries = yield* Ref.make<ReadonlyArray<ListIdleThreadCandidatesInput>>([]);
    const candidates = yield* Ref.make<ReadonlyArray<IdleThreadCandidate>>([candidate(state)]);
    yield* startThreadIdleCleanup({
      orchestrationEngine: {
        dispatch: (command) =>
          Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 })),
      },
      threadRepository: {
        listIdleCandidates: (query) =>
          Ref.update(queries, (all) => [...all, query]).pipe(
            Effect.andThen(Ref.get(candidates)),
            Effect.map((all) => all.filter((entry) => query.states.includes(entry.state))),
          ),
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
      ? [command.threadId, command.expectedRevision, command.fromState, command.destination]
      : [command.type],
  );

it.effect("does nothing while both rules are off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dispatched, queries, advance } = yield* harness(off);
      yield* advance(30 * MINUTE);
      assert.deepEqual(yield* Ref.get(dispatched), []);
      assert.deepEqual(yield* Ref.get(queries), []);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("by default waits 10 minutes after start, then moves Present to Later", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dispatched, queries, advance } = yield* harness(DEFAULT_SERVER_SETTINGS);
      yield* advance(9 * MINUTE + 45_000);
      assert.deepEqual(yield* Ref.get(dispatched), []);
      yield* advance(15_000);
      assert.deepEqual(moves(yield* Ref.get(dispatched)), [[threadA, 3, "present", "later"]]);
      const [query] = yield* Ref.get(queries);
      assert.deepEqual(query?.states, ["present"]);
      assert.equal(query?.cutoff, new Date(0).toISOString());
      // A declined candidate is not retried at the same revision for a minute.
      yield* advance(45_000);
      assert.equal((yield* Ref.get(dispatched)).length, 1);
      yield* advance(15_000);
      assert.equal((yield* Ref.get(dispatched)).length, 2);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("an idle-rule change restarts its wait and uses the new destination", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dispatched, change, advance } = yield* harness(DEFAULT_SERVER_SETTINGS);
      yield* advance(8 * MINUTE);
      yield* change({
        ...DEFAULT_SERVER_SETTINGS,
        itutuIdleDestination: "done",
        itutuIdleTimeoutMinutes: 12,
      });
      yield* advance(11 * MINUTE + 45_000);
      assert.deepEqual(yield* Ref.get(dispatched), []);
      yield* advance(15_000);
      assert.deepEqual(moves(yield* Ref.get(dispatched)), [[threadA, 3, "present", "done"]]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("by default moves an old Later thread to Done after a day", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dispatched, queries, advance } = yield* harness(DEFAULT_SERVER_SETTINGS, "later");
      yield* advance(DAY - 15_000);
      assert.deepEqual(yield* Ref.get(dispatched), []);
      yield* advance(15_000);
      assert.deepEqual(moves(yield* Ref.get(dispatched)), [[threadA, 3, "later", "done"]]);
      const older = (yield* Ref.get(queries)).find((query) => query.states.includes("later"));
      assert.deepEqual(older?.states, ["present", "later"]);
      assert.equal(older?.cutoff, new Date(0).toISOString());
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("changing one rule restarts only that rule's wait", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dispatched, change, advance } = yield* harness(DEFAULT_SERVER_SETTINGS, "later");
      yield* advance(DAY - 15 * MINUTE);
      yield* change({ ...DEFAULT_SERVER_SETTINGS, itutuIdleTimeoutMinutes: 20 });
      yield* advance(15 * MINUTE);
      assert.deepEqual(moves(yield* Ref.get(dispatched)), [[threadA, 3, "later", "done"]]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("turning the older-threads rule on gives every thread a full new wait", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dispatched, change, advance } = yield* harness(off, "later");
      yield* advance(2 * MINUTE);
      yield* change({ ...off, itutuOlderThreadsEnabled: true, itutuOlderThreadsDays: 2 });
      yield* advance(2 * DAY - 15_000);
      assert.deepEqual(yield* Ref.get(dispatched), []);
      yield* advance(15_000);
      assert.deepEqual(moves(yield* Ref.get(dispatched)), [[threadA, 3, "later", "done"]]);
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
