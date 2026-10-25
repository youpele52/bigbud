/**
 * The recovery pass: classification of observed failures against sleep epochs, settling turns
 * whose failure no sleep explains, marking turns that ran across a sleep as observed, and
 * applying the policy (`ProviderTurnSupervisor.evaluate`) to every intent in recovery.
 *
 * Each pass is bounded and indexed: it queries unresolved intents, and looks up only their
 * threads and liveness rows.
 *
 * @module ProviderTurnSupervisor.recovery
 */
import type { ThreadRecoveryStatus } from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { Effect, Option } from "effect";

import type { ThreadRecoveryIntent } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import type { SleepEpoch } from "../../system-sleep/SystemSleepEpochs.logic.ts";
import {
  classifyTurnFailure,
  intentTurnWasRunning,
  TURN_ENDING_FAILURE_KINDS,
  type TurnFailureObservation,
  type TurnRunningEvidence,
} from "./ProviderTurnSupervisor.classify.logic.ts";
import {
  clearNoticeFor,
  findThread,
  moveIntent,
  publishRecovery,
  settleIntent,
  USER_PROMPT_STATUSES,
} from "./ProviderTurnSupervisor.continue.ts";
import { isThreadWaitingForUser } from "../ThreadDispatchSafety.logic.ts";
import { evaluateIntent } from "./ProviderTurnSupervisor.evaluate.ts";
import { forEachActiveIntent } from "./ProviderTurnSupervisor.intents.ts";
import {
  MAX_PENDING_FAILURES,
  PENDING_FAILURE_GRACE_MS,
  PENDING_FAILURE_MAX_STEP_MS,
  setBounded,
  type PendingTurnFailure,
  type RecoveryContext,
  type RecoveryNoticeKey,
} from "./ProviderTurnSupervisor.state.ts";
import { trackingForTurn } from "./ProviderTurnSupervisor.tools.logic.ts";

/**
 * Statuses a recovery pass evaluates: each one moves on by itself (a send, a bind, a timeout).
 * Prompts that wait for the user are not listed here, so they can never take every slot of the
 * bounded query; only the ones provider activity can still change are read, separately.
 */
export const ACTIONABLE_RECOVERY_STATUSES: ReadonlyArray<ThreadRecoveryStatus> = [
  "interrupted-by-sleep",
  "observing",
  "continuing",
  "provider-continued",
];
/** "No activity since wake" prompts read per pass, newest first. */
const AWAITING_PROVIDER_ACTIVITY_LIMIT = 50;
/** Statuses whose turn a sleep can still cut. */
export const CLASSIFIABLE_STATUSES: ReadonlySet<ThreadRecoveryStatus> =
  new Set<ThreadRecoveryStatus>(["none", "observing", "provider-continued"]);

const epochAt = (ctx: RecoveryContext, atMs: number) =>
  Option.isSome(ctx.sleep)
    ? ctx.sleep.value.epochAt(atMs)
    : Effect.succeed(Option.none<SleepEpoch>());

/** Whether the turn's latest dispatch may have reached the provider. */
const mayHaveBeenSent = (ctx: RecoveryContext, intent: ThreadRecoveryIntent) =>
  Option.isNone(ctx.attempts)
    ? Effect.succeed(intent.turnId !== null)
    : ctx.attempts.value
        .latestForIntent({ threadId: intent.threadId, messageId: intent.messageId })
        .pipe(
          Effect.map((attempt) =>
            Option.match(attempt, {
              onNone: () => false,
              onSome: (value) => value.state !== "prepared",
            }),
          ),
        );

/** What the thread, the coordinator's tracking and liveness say about the intent's turn. */
const turnRunningEvidence = Effect.fn("turnRunningEvidence")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
) {
  const thread = yield* findThread(ctx, intent.threadId);
  const session = thread?.session;
  const tracking = trackingForTurn(ctx.memory.turnTools.get(intent.threadId), intent.turnId);
  const livenessRows =
    intent.turnId === null ? [] : yield* ctx.providerService.listActiveTurnLiveness();
  return {
    runningActiveTurnId:
      session?.status === "running" || session?.status === "starting"
        ? (session.activeTurnId ?? null)
        : null,
    pendingStartMessageId: thread?.pendingTurnStart?.messageId ?? null,
    trackedRunning:
      intent.turnId !== null && tracking?.turnId === intent.turnId ? !tracking.ended : null,
    livenessActive: livenessRows.some(
      (row) => row.threadId === intent.threadId && row.turnId === intent.turnId,
    ),
  } satisfies TurnRunningEvidence;
});

/**
 * Records a terminal failure; classifies it now or once a sleep epoch explains it. Only a
 * failure of the intent's running turn counts. `pending` is a re-check of a held failure,
 * which belongs to the intent it was first observed for.
 */
export const recordTurnFailure = Effect.fn("recordTurnFailure")(function* (
  ctx: RecoveryContext,
  observation: TurnFailureObservation,
  pending?: PendingTurnFailure,
) {
  const latest = yield* ctx.intents.latestOpenForThread(observation.threadId);
  if (Option.isNone(latest)) return;
  const intent = latest.value;
  if (pending !== undefined && pending.messageId !== intent.messageId) return;
  if (intent.disposition !== "active" || !CLASSIFIABLE_STATUSES.has(intent.recoveryStatus)) return;
  if (!(yield* mayHaveBeenSent(ctx, intent))) return;
  if (
    pending === undefined &&
    !intentTurnWasRunning(intent, observation, yield* turnRunningEvidence(ctx, intent))
  ) {
    return;
  }
  const epoch = yield* epochAt(ctx, observation.observedAtMs);
  const classification = classifyTurnFailure({
    intent,
    observation,
    inSleepWindow: Option.isSome(epoch),
  });
  if (classification === "ordinary") {
    // The sleep evidence may arrive a moment after the failure it caused.
    if (pending === undefined) {
      setBounded(
        ctx.memory.pendingFailures,
        observation.threadId,
        { observation, messageId: intent.messageId, heldMs: 0, lastCheckedAtMs: ctx.nowMs() },
        MAX_PENDING_FAILURES,
      );
    }
    return;
  }
  ctx.memory.pendingFailures.delete(observation.threadId);
  const wokeAtMs = Option.isSome(epoch) ? epoch.value.endedAtMs : observation.observedAtMs;
  const moved = yield* moveIntent(ctx, intent, {
    recoveryStatus: "interrupted-by-sleep",
    detail: {
      ...intent.detail,
      reason: "interrupted-by-sleep",
      wokeAt: new Date(wokeAtMs).toISOString(),
      failureObservedAt: new Date(observation.observedAtMs).toISOString(),
      ...(observation.detail ? { failureDetail: observation.detail.slice(0, 500) } : {}),
      ...(Option.isSome(epoch) ? { sleepEpochId: epoch.value.epochId } : {}),
    },
  });
  yield* Effect.logInfo("turn classified as interrupted by sleep", {
    threadId: intent.threadId,
    messageId: intent.messageId,
    kind: observation.kind,
  });
  if (Option.isSome(moved)) yield* evaluateIntent(ctx, moved.value);
});

/**
 * No sleep explained the failure: it is ordinary, and the intent is settled so that no later
 * failure can resurrect it. A runtime or session error that left the turn running is kept;
 * that turn settles when it ends.
 */
const settleOrdinaryFailure = Effect.fn("settleOrdinaryFailure")(function* (
  ctx: RecoveryContext,
  pending: PendingTurnFailure,
) {
  const found = yield* ctx.intents.get({
    threadId: pending.observation.threadId,
    messageId: pending.messageId,
  });
  if (Option.isNone(found)) return;
  const intent = found.value;
  if (intent.disposition !== "active" || !CLASSIFIABLE_STATUSES.has(intent.recoveryStatus)) return;
  if (!TURN_ENDING_FAILURE_KINDS.has(pending.observation.kind)) {
    const evidence = yield* turnRunningEvidence(ctx, intent);
    if (intentTurnWasRunning(intent, { ...pending.observation, turnId: null }, evidence)) return;
  }
  yield* Effect.logInfo("turn failed outside any sleep; recovery intent settled", {
    threadId: intent.threadId,
    messageId: intent.messageId,
    kind: pending.observation.kind,
  });
  yield* settleIntent(ctx, intent);
});

/**
 * Re-tries classification of failures that came before their sleep evidence. The hold counts
 * awake time only: one check adds at most `PENDING_FAILURE_MAX_STEP_MS`, so a failure seen
 * just before suspend still meets the epoch that arrives after wake.
 */
export const classifyPendingFailures = Effect.fn("classifyPendingFailures")(function* (
  ctx: RecoveryContext,
) {
  const nowMs = ctx.nowMs();
  // Snapshot first: recordTurnFailure may change the map while we iterate.
  const pending = Array.from(ctx.memory.pendingFailures);
  for (const [threadId, entry] of pending) {
    entry.heldMs += Math.min(
      PENDING_FAILURE_MAX_STEP_MS,
      Math.max(0, nowMs - entry.lastCheckedAtMs),
    );
    entry.lastCheckedAtMs = nowMs;
    if (Option.isSome(yield* epochAt(ctx, entry.observation.observedAtMs))) {
      ctx.memory.pendingFailures.delete(threadId);
      yield* recordTurnFailure(ctx, entry.observation, entry);
      continue;
    }
    if (entry.heldMs < PENDING_FAILURE_GRACE_MS) continue;
    ctx.memory.pendingFailures.delete(threadId);
    yield* settleOrdinaryFailure(ctx, entry);
  }
});

/**
 * A sleep ended: every turn that was running across it is now observed. A turn that waits for
 * an approval or an answer is not running; the user's own prompt is already on screen.
 */
export const observeTurnsAcrossSleep = Effect.fn("observeTurnsAcrossSleep")(function* (
  ctx: RecoveryContext,
  epoch: SleepEpoch,
) {
  yield* forEachActiveIntent(ctx, ["none", "provider-continued"], (intent) =>
    Effect.gen(function* () {
      if (Date.parse(intent.createdAt) > epoch.endedAtMs) return;
      const thread = yield* findThread(ctx, intent.threadId);
      const running =
        thread?.session?.status === "running" ||
        (intent.turnId !== null && thread?.session?.activeTurnId === intent.turnId);
      if (!thread || !running || isThreadWaitingForUser(thread)) return;
      if (!(yield* mayHaveBeenSent(ctx, intent))) return;
      yield* moveIntent(ctx, intent, {
        recoveryStatus: "observing",
        detail: {
          ...intent.detail,
          sleepEpochId: epoch.epochId,
          wokeAt: new Date(epoch.endedAtMs).toISOString(),
        },
      });
    }),
  );
});

/** Publishes what the intent shows now: its state while it may still be acted on, else nothing. */
const republishNotice = Effect.fn("republishRecoveryNotice")(function* (
  ctx: RecoveryContext,
  key: RecoveryNoticeKey,
) {
  const found = yield* ctx.intents.get(key);
  if (Option.isNone(found)) return yield* clearNoticeFor(ctx, key);
  const intent = found.value;
  const visible =
    intent.disposition === "active" ||
    (intent.disposition === "suspended-for-exit" &&
      USER_PROMPT_STATUSES.has(intent.recoveryStatus));
  yield* publishRecovery(ctx, visible ? intent : { ...intent, recoveryStatus: "none" });
});

/**
 * Retries notices whose publish failed. Prompts that wait for the user are not re-read by the
 * pass, so without this a failed publish would leave a prompt hidden for good. A notice that
 * already matches its intent is not dispatched again (`sameThreadRecovery`).
 */
const republishFailedNotices = Effect.fn("republishFailedRecoveryNotices")(function* (
  ctx: RecoveryContext,
) {
  const failed = Array.from(ctx.memory.unpublishedNotices);
  for (const [noticeKey, key] of failed) {
    // A new failure records it again.
    ctx.memory.unpublishedNotices.delete(noticeKey);
    yield* republishNotice(ctx, key);
  }
});

/** One bounded pass over the intents in recovery. */
export const runRecoveryPass = Effect.fn("runRecoveryPass")(function* (ctx: RecoveryContext) {
  yield* republishFailedNotices(ctx);
  yield* classifyPendingFailures(ctx);
  const actionable = yield* ctx.intents.listActive({ statuses: ACTIONABLE_RECOVERY_STATUSES });
  const prompts = yield* ctx.intents.listAwaitingProviderActivity({
    limit: AWAITING_PROVIDER_ACTIVITY_LIMIT,
  });
  const intents = [...actionable, ...prompts];
  if (intents.length === 0) return;
  const liveness = yield* ctx.providerService.listActiveTurnLiveness();
  for (const intent of intents) {
    yield* evaluateIntent(ctx, intent, liveness).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("sleep recovery evaluation failed", {
          threadId: intent.threadId,
          messageId: intent.messageId,
          cause,
        }),
      ),
    );
  }
});
