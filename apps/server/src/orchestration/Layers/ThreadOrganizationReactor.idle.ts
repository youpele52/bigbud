/**
 * Inyosira idle cleanup, in two rules checked every 15 s:
 * - idle: quiescent Present threads quiet for the timeout move to the destination (Later);
 * - older threads: quiescent Present or Later threads quiet for the age move to Done.
 * Each rule's timing starts no earlier than its latest barrier: server start, a change to that
 * rule (including turning it on), or a long pause in this loop (system sleep or a stalled
 * process), so no thread moves on stale clock time. The decider rechecks every gate when it
 * applies the move, so work admitted in the meantime always wins.
 *
 * @module ThreadOrganizationReactor.idle
 */
import { CommandId, type ServerSettings } from "@bigbud/contracts";
import { Clock, Effect, Ref, Schedule, Stream } from "effect";

import { stableThreadToolId } from "../../orchestration-tools/ThreadOrchestrationTools.origins.ts";
import type { ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";
import type { ServerSettingsShape } from "../../ws/serverSettings.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

export const IDLE_SWEEP_INTERVAL_MS = 15_000;
export const IDLE_SWEEP_BATCH = 50;
const IDLE_CONCURRENCY = 3;
/** A gap this much longer than the interval means the process slept or stalled. */
export const IDLE_DISCONTINUITY_MS = 60_000;
/** A candidate the decider declined is not retried at the same revision for a minute. */
export const IDLE_RETRY_AFTER_MS = 60_000;

type IdlePolicy = Pick<
  ServerSettings,
  | "inyosiraIdleCleanupEnabled"
  | "inyosiraIdleTimeoutMinutes"
  | "inyosiraIdleDestination"
  | "inyosiraOlderThreadsEnabled"
  | "inyosiraOlderThreadsDays"
>;

export interface IdleRule {
  readonly name: "idle" | "older";
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly fromStates: ReadonlyArray<"present" | "later">;
  readonly destination: "done" | "later";
}

/** The two rules a settings snapshot describes, in the order a tick applies them. */
export function idleRulesFor(settings: IdlePolicy): ReadonlyArray<IdleRule> {
  return [
    {
      name: "idle",
      enabled: settings.inyosiraIdleCleanupEnabled,
      timeoutMs: settings.inyosiraIdleTimeoutMinutes * 60_000,
      fromStates: ["present"],
      destination: settings.inyosiraIdleDestination,
    },
    {
      name: "older",
      enabled: settings.inyosiraOlderThreadsEnabled,
      timeoutMs: settings.inyosiraOlderThreadsDays * 24 * 60 * 60_000,
      fromStates: ["present", "later"],
      destination: "done",
    },
  ];
}

/**
 * The barrier after a tick: a gap much longer than the sweep interval means the process slept or
 * stalled, so the wait restarts rather than trusting time that passed while nothing was observed.
 */
export function idleBarrierAfterTick(input: {
  readonly barrierMs: number;
  readonly previousTickMs: number;
  readonly nowMs: number;
}): number {
  return input.nowMs - input.previousTickMs > IDLE_SWEEP_INTERVAL_MS + IDLE_DISCONTINUITY_MS
    ? input.nowMs
    : input.barrierMs;
}

const ruleKey = (rule: IdleRule) =>
  JSON.stringify([rule.enabled, rule.timeoutMs, rule.fromStates, rule.destination]);

export const startThreadIdleCleanup = Effect.fn("startThreadIdleCleanup")(function* (input: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly threadRepository: Pick<ProjectionThreadRepositoryShape, "listIdleCandidates">;
  readonly settings: Pick<ServerSettingsShape, "getSettings" | "streamChanges">;
}) {
  const startedAt = yield* Clock.currentTimeMillis;
  const barriers = yield* Ref.make<Record<IdleRule["name"], number>>({
    idle: startedAt,
    older: startedAt,
  });
  const lastTick = yield* Ref.make(startedAt);
  const lastPolicy = yield* Ref.make<Record<IdleRule["name"], string> | null>(null);
  const attempted = new Map<string, number>();

  const observePolicy = (settings: IdlePolicy) =>
    Effect.gen(function* () {
      const rules = idleRulesFor(settings);
      const keys = { idle: ruleKey(rules[0]!), older: ruleKey(rules[1]!) };
      const previous = yield* Ref.getAndSet(lastPolicy, keys);
      if (previous === null) return;
      // Turning a rule on or changing it gives every thread a full new wait for that rule.
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Ref.update(barriers, (current) => ({
        idle: previous.idle !== keys.idle ? nowMs : current.idle,
        older: previous.older !== keys.older ? nowMs : current.older,
      }));
    });

  const applyRule = (rule: IdleRule, nowMs: number) =>
    Effect.gen(function* () {
      if (!rule.enabled) return;
      if (nowMs - (yield* Ref.get(barriers))[rule.name] < rule.timeoutMs) return;
      const createdAt = new Date(nowMs).toISOString();
      const candidates = (yield* input.threadRepository.listIdleCandidates({
        states: rule.fromStates,
        cutoff: new Date(nowMs - rule.timeoutMs).toISOString(),
        limit: IDLE_SWEEP_BATCH,
      })).filter((candidate) => !attempted.has(`${candidate.threadId}:${candidate.revision}`));
      yield* Effect.forEach(
        candidates,
        (candidate) => {
          attempted.set(`${candidate.threadId}:${candidate.revision}`, nowMs + IDLE_RETRY_AFTER_MS);
          return input.orchestrationEngine
            .dispatch({
              type: "thread.organization.idle",
              commandId: CommandId.makeUnsafe(
                stableThreadToolId(
                  "inyosira-idle",
                  JSON.stringify([candidate.threadId, candidate.revision, createdAt]),
                ),
              ),
              threadId: candidate.threadId,
              expectedRevision: candidate.revision,
              fromState: candidate.state,
              destination: rule.destination,
              createdAt,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("idle cleanup move failed; retried after a minute", {
                  threadId: candidate.threadId,
                  rule: rule.name,
                  cause: cause.toString(),
                }),
              ),
            );
        },
        { concurrency: IDLE_CONCURRENCY, discard: true },
      );
    });

  const tick = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const previousTickMs = yield* Ref.getAndSet(lastTick, nowMs);
    yield* Ref.update(barriers, (current) => ({
      idle: idleBarrierAfterTick({ barrierMs: current.idle, previousTickMs, nowMs }),
      older: idleBarrierAfterTick({ barrierMs: current.older, previousTickMs, nowMs }),
    }));
    const settings = yield* input.settings.getSettings;
    yield* observePolicy(settings);
    for (const [key, retryAt] of attempted) if (retryAt <= nowMs) attempted.delete(key);
    // Older threads first, so a thread past both waits goes straight to Done.
    const [idleRule, olderRule] = idleRulesFor(settings);
    yield* applyRule(olderRule!, nowMs);
    yield* applyRule(idleRule!, nowMs);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("idle cleanup sweep failed", { cause: cause.toString() }),
    ),
  );

  yield* Effect.forkScoped(
    Stream.runForEach(input.settings.streamChanges, (settings) => observePolicy(settings)),
  );
  yield* Effect.forkScoped(
    Effect.sleep(IDLE_SWEEP_INTERVAL_MS).pipe(
      Effect.andThen(tick.pipe(Effect.repeat(Schedule.spaced(`${IDLE_SWEEP_INTERVAL_MS} millis`)))),
    ),
  );
});
