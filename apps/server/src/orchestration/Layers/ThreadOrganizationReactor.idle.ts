/**
 * Ìtútù idle cleanup. Every 15 s, while enabled, quiescent Present threads quiet for the timeout
 * move to the configured destination. Timing starts no earlier than the latest barrier: server
 * start, a policy change (including turning it on), or a long pause in this loop (system sleep
 * or a stalled process), so no thread moves on stale clock time. The decider rechecks every
 * gate when it applies the move, so work admitted in the meantime always wins.
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
  "itutuIdleCleanupEnabled" | "itutuIdleTimeoutMinutes" | "itutuIdleDestination"
>;

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

const policyKey = (settings: IdlePolicy) =>
  JSON.stringify([
    settings.itutuIdleCleanupEnabled,
    settings.itutuIdleTimeoutMinutes,
    settings.itutuIdleDestination,
  ]);

export const startThreadIdleCleanup = Effect.fn("startThreadIdleCleanup")(function* (input: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly threadRepository: Pick<ProjectionThreadRepositoryShape, "listIdleCandidates">;
  readonly settings: Pick<ServerSettingsShape, "getSettings" | "streamChanges">;
}) {
  const startedAt = yield* Clock.currentTimeMillis;
  const barrier = yield* Ref.make(startedAt);
  const lastTick = yield* Ref.make(startedAt);
  const lastPolicy = yield* Ref.make<string | null>(null);
  const attempted = new Map<string, number>();

  const observePolicy = (settings: IdlePolicy) =>
    Effect.gen(function* () {
      const key = policyKey(settings);
      const previous = yield* Ref.getAndSet(lastPolicy, key);
      // Turning cleanup on or changing it gives every thread a full new timeout.
      if (previous !== null && previous !== key) {
        yield* Ref.set(barrier, yield* Clock.currentTimeMillis);
      }
    });

  const tick = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const previousTickMs = yield* Ref.getAndSet(lastTick, nowMs);
    yield* Ref.update(barrier, (barrierMs) =>
      idleBarrierAfterTick({ barrierMs, previousTickMs, nowMs }),
    );
    const settings = yield* input.settings.getSettings;
    yield* observePolicy(settings);
    if (!settings.itutuIdleCleanupEnabled) return;
    const timeoutMs = settings.itutuIdleTimeoutMinutes * 60_000;
    if (nowMs - (yield* Ref.get(barrier)) < timeoutMs) return;

    for (const [key, retryAt] of attempted) if (retryAt <= nowMs) attempted.delete(key);
    const createdAt = new Date(nowMs).toISOString();
    const candidates = (yield* input.threadRepository.listIdleCandidates({
      cutoff: new Date(nowMs - timeoutMs).toISOString(),
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
                "itutu-idle",
                JSON.stringify([candidate.threadId, candidate.revision, createdAt]),
              ),
            ),
            threadId: candidate.threadId,
            expectedRevision: candidate.revision,
            destination: settings.itutuIdleDestination,
            createdAt,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("idle cleanup move failed; retried after a minute", {
                threadId: candidate.threadId,
                cause: cause.toString(),
              }),
            ),
          );
      },
      { concurrency: IDLE_CONCURRENCY, discard: true },
    );
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
