import { type OrchestrationCommand, type ServerSettings, ThreadId } from "@bigbud/contracts";
import { Clock, Effect, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import type {
  IdleThreadCandidate,
  ListIdleThreadCandidatesInput,
} from "../../persistence/Services/ProjectionThreads.ts";
import type { TerminalIdleWork } from "../../terminal/Services/Manager.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  IDLE_SWEEP_INTERVAL_MS,
  startThreadIdleCleanup,
} from "./ThreadOrganizationReactor.idle.ts";

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const terminalCandidate = (
  id: string,
  state: "present" | "later" = "present",
): IdleThreadCandidate => ({
  threadId: ThreadId.makeUnsafe(id),
  state,
  revision: 0,
  activityAt: new Date(-2 * DAY).toISOString(),
});

/** Small terminal-only fixture. No test registration or duplicated sleep/wake policy model. */
export const terminalSweepFixture = Effect.fn("terminalSweepFixture")(function* (input: {
  settings: ServerSettings;
  candidates: ReadonlyArray<IdleThreadCandidate>;
  work?: Map<string, TerminalIdleWork>;
  dispatch?: OrchestrationEngineShape["dispatch"];
}) {
  let settings = input.settings;
  let candidates = input.candidates;
  const work = input.work ?? new Map<string, TerminalIdleWork>();
  const commands: OrchestrationCommand[] = [];
  const queries: ListIdleThreadCandidatesInput[] = [];
  let workReads = 0;
  const changes = yield* Queue.unbounded<ServerSettings>();
  const settle = Effect.gen(function* () {
    for (let index = 0; index < 30; index++) yield* Effect.yieldNow;
  });
  yield* startThreadIdleCleanup({
    settings: {
      getSettings: Effect.sync(() => settings),
      streamChanges: Stream.fromQueue(changes),
    },
    terminalManager: {
      getThreadIdleWork: (threadId) =>
        Effect.sync(() => {
          workReads++;
          return work.get(threadId) ?? { state: "idle", quietSince: null };
        }),
    },
    threadRepository: {
      listIdleCandidates: (query) =>
        Effect.sync(() => {
          queries.push(query);
          return candidates
            .filter(
              (candidate) =>
                query.states.includes(candidate.state) &&
                candidate.activityAt <= query.cutoff &&
                !query.excludeThreadIds?.includes(candidate.threadId) &&
                (!query.after ||
                  candidate.activityAt > query.after.activityAt ||
                  (candidate.activityAt === query.after.activityAt &&
                    candidate.threadId > query.after.threadId)),
            )
            .toSorted(
              (left, right) =>
                left.activityAt.localeCompare(right.activityAt) ||
                left.threadId.localeCompare(right.threadId),
            )
            .slice(0, query.limit);
        }),
    },
    orchestrationEngine: {
      dispatch: (command) =>
        Effect.gen(function* () {
          commands.push(command);
          if (input.dispatch) return yield* input.dispatch(command);
          candidates = candidates.filter(
            (candidate) => candidate.threadId !== ("threadId" in command ? command.threadId : null),
          );
          return { sequence: commands.length };
        }),
    },
  });
  const advance = (milliseconds: number) =>
    Effect.gen(function* () {
      // Preserve ordinary polling cadence instead of simulating a sleep/stall.
      for (let remaining = milliseconds; remaining > 0; remaining -= IDLE_SWEEP_INTERVAL_MS) {
        yield* TestClock.adjust(`${Math.min(remaining, IDLE_SWEEP_INTERVAL_MS)} millis`);
        yield* settle;
      }
    });
  return {
    establishEligibility: (milliseconds: number) =>
      Effect.gen(function* () {
        const pending = candidates;
        candidates = [];
        yield* advance(milliseconds);
        candidates = pending;
        queries.length = 0;
        workReads = 0;
      }),
    work,
    commands,
    queries,
    get workReads() {
      return workReads;
    },
    now: Clock.currentTimeMillis,
    advance,
    change: (next: ServerSettings) =>
      Effect.sync(() => {
        settings = next;
      }).pipe(Effect.andThen(Queue.offer(changes, next)), Effect.andThen(settle)),
  };
});
