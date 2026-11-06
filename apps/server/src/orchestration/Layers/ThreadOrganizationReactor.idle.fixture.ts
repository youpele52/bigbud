/**
 * Inyosira idle cleanup, in two rules checked every 15 s:
 * - idle: quiescent Present threads quiet for the timeout move to the destination (Later);
 * - older threads: quiescent Present or Later threads quiet for the age move to Done.
 * The short idle rule restarts its wait at server start and after sleep/stalls. The older-thread
 * rule uses persisted inactivity across those interruptions, not uninterrupted server uptime.
 * Changing either policy (including enabling it) still grants that rule a full new wait.
 * The decider rechecks every gate when applying the move, so admitted work always wins.
 *
 * Legacy TS scheduler kept ONLY as a test fixture/reference: Rust is the sole production
 * scheduler and no production module may import this file (static test enforces it).
 *
 * @module ThreadOrganizationReactor.idle.fixture
 */
import { makeIdleSweepPaging } from "./ThreadOrganizationReactor.idle.paging.ts";
import { terminalWorkAllowsIdle } from "../../terminal/Layers/Manager.idleWork.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { CommandId, type ThreadId } from "@bigbud/contracts";
import { idleRulesFor, type IdlePolicy, type IdleRule } from "../threadOrganization.idleRules.ts";
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
  readonly terminalManager?: Pick<TerminalManagerShape, "getThreadIdleWork">;
}) {
  const startedAt = yield* Clock.currentTimeMillis;
  const barriers = yield* Ref.make<Record<IdleRule["name"], number>>({
    idle: startedAt,
    // Age is durable; requiring another full day of uptime starves this rule on daily restarts.
    older: Number.NEGATIVE_INFINITY,
  });
  const lastTick = yield* Ref.make(startedAt);
  const lastPolicy = yield* Ref.make<Record<IdleRule["name"], string> | null>(null);
  const attempted = new Map<
    string,
    { threadId: ThreadId; retryAt: number; rule?: IdleRule["name"] }
  >();
  const paging = makeIdleSweepPaging();

  const observePolicy = (settings: IdlePolicy) =>
    Effect.gen(function* () {
      const rules = idleRulesFor(settings);
      const keys = { idle: ruleKey(rules[0]!), older: ruleKey(rules[1]!) };
      const previous = yield* Ref.getAndSet(lastPolicy, keys);
      if (previous === null) return;
      for (const rule of rules)
        if (previous[rule.name] !== keys[rule.name]) paging.reset(rule.name);
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
      const after = paging.after(rule.name);
      const page = yield* input.threadRepository.listIdleCandidates({
        states: rule.fromStates,
        ...(after ? { after } : {}),
        excludeThreadIds: [
          ...new Set(
            [...attempted.values()]
              .filter((entry) => entry.rule === undefined || entry.rule === rule.name)
              .map((entry) => entry.threadId),
          ),
        ],
        cutoff: new Date(nowMs - rule.timeoutMs).toISOString(),
        limit: IDLE_SWEEP_BATCH,
      });
      paging.advance(rule.name, page, IDLE_SWEEP_BATCH);
      const candidates = page.filter(
        (candidate) =>
          !attempted.has(`${candidate.threadId}:${candidate.revision}`) &&
          !attempted.has(`${rule.name}:${candidate.threadId}:${candidate.revision}`),
      );
      yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            const work = yield* (
              input.terminalManager?.getThreadIdleWork?.(candidate.threadId) ??
                Effect.succeed({ state: "idle" as const, quietSince: null })
            );
            const allowed = terminalWorkAllowsIdle(work, nowMs - rule.timeoutMs);
            const key = `${candidate.threadId}:${candidate.revision}`;
            attempted.set(allowed ? key : `${rule.name}:${key}`, {
              threadId: candidate.threadId,
              retryAt: nowMs + IDLE_RETRY_AFTER_MS,
              ...(allowed ? {} : { rule: rule.name }),
            });
            if (!allowed) return;
            yield* input.orchestrationEngine
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
                terminalIdleCutoff: new Date(nowMs - rule.timeoutMs).toISOString(),
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
          }),
        { concurrency: IDLE_CONCURRENCY, discard: true },
      );
    });

  const tick = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const previousTickMs = yield* Ref.getAndSet(lastTick, nowMs);
    yield* Ref.update(barriers, (current) => ({
      idle: idleBarrierAfterTick({ barrierMs: current.idle, previousTickMs, nowMs }),
      // Sleep does not erase persisted age or an explicit policy-change grace period.
      older: current.older,
    }));
    const settings = yield* input.settings.getSettings;
    yield* observePolicy(settings);
    for (const [key, entry] of attempted) if (entry.retryAt <= nowMs) attempted.delete(key);
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
