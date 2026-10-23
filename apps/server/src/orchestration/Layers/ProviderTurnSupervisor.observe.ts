/**
 * Routes already-published streams into the recovery coordinator: canonical provider runtime
 * events, orchestration domain events and sleep epochs. Ingestion never calls the
 * coordinator directly.
 *
 * @module ProviderTurnSupervisor.observe
 */
import type { OrchestrationEvent, ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";
import {
  PROVIDER_CHECKING_SESSION_REASON,
  PROVIDER_RECOVERING_SESSION_REASON,
  PROVIDER_STALLED_SESSION_REASON,
} from "@bigbud/contracts/constants/providerRuntime.constant";
import { Effect, Option } from "effect";

import type { SystemSleepEvent } from "../../system-sleep/Services/SystemSleepEpochs.ts";
import {
  completionBelongsToIntent,
  failureFromDomainEvent,
  failureFromRuntimeEvent,
  isCompletedTurnEvent,
  isProgressEvent,
  isTurnEndedWithoutCompletion,
} from "./ProviderTurnSupervisor.classify.logic.ts";
import {
  clearStaleNotice,
  continuationFailed,
  settleIntent,
} from "./ProviderTurnSupervisor.continue.ts";
import {
  CLASSIFIABLE_STATUSES,
  classifyPendingFailures,
  observeTurnsAcrossSleep,
  recordTurnFailure,
  runRecoveryPass,
} from "./ProviderTurnSupervisor.recovery.ts";
import { resolveRecovery } from "./ProviderTurnSupervisor.resolve.ts";
import {
  MAX_TRACKED_THREADS,
  setBounded,
  type RecoveryContext,
} from "./ProviderTurnSupervisor.state.ts";
import { trackTurnToolEvent } from "./ProviderTurnSupervisor.tools.logic.ts";

/** Session reasons the turn supervisor itself projects; they are not provider failures. */
const SUPERVISOR_HEALTH_REASONS = new Set<string>([
  PROVIDER_CHECKING_SESSION_REASON,
  PROVIDER_RECOVERING_SESSION_REASON,
  PROVIDER_STALLED_SESSION_REASON,
]);

/**
 * A turn that ended settles its intent. A completed turn settles unless a continuation or a
 * parked prompt owns the intent, and only when it is the intent's own turn
 * (`completionBelongsToIntent`). An interrupted or cancelled turn is never continued; it
 * settles while recovery has not started on it, so a later failure cannot resurrect it.
 */
const settleEndedTurn = Effect.fn("settleEndedTurn")(function* (
  ctx: RecoveryContext,
  event: ProviderRuntimeEvent,
  completed: boolean,
) {
  const latest = yield* ctx.intents.latestOpenForThread(event.threadId);
  if (Option.isNone(latest) || latest.value.disposition !== "active") return;
  const intent = latest.value;
  if (completed) {
    if (intent.recoveryStatus === "continuing" || intent.recoveryStatus === "parked") return;
    const tracking = ctx.memory.turnTools.get(event.threadId);
    if (!completionBelongsToIntent(intent, event.turnId ?? null, tracking)) return;
  } else {
    if (!CLASSIFIABLE_STATUSES.has(intent.recoveryStatus)) return;
    // Strict: Stop and continue interrupts the original turn after the continuation's own
    // (still unbound) intent was seeded; that intent must not settle for the old turn.
    if (event.turnId && intent.turnId !== event.turnId) return;
  }
  yield* settleIntent(ctx, intent);
});

/**
 * When the provider produced the event. Progress and completion keep the event's own time: an
 * event buffered at wake may wait behind the coordinator for seconds, and its processing time
 * would make it look like progress after wake.
 */
const eventAtMs = (event: ProviderRuntimeEvent, fallbackMs: number) => {
  const atMs = Date.parse(event.createdAt);
  return Number.isFinite(atMs) ? atMs : fallbackMs;
};

/** Keeps the latest time per thread; an event delivered out of order never moves it back. */
const recordLatest = (map: Map<ThreadId, number>, threadId: ThreadId, atMs: number) =>
  setBounded(map, threadId, Math.max(map.get(threadId) ?? atMs, atMs), MAX_TRACKED_THREADS);

export const observeRuntimeEvent = Effect.fn("observeRecoveryRuntimeEvent")(function* (
  ctx: RecoveryContext,
  event: ProviderRuntimeEvent,
) {
  const nowMs = ctx.nowMs();
  trackTurnToolEvent(ctx.memory.turnTools, event, MAX_TRACKED_THREADS);
  if (isProgressEvent(event)) {
    recordLatest(ctx.memory.lastProgressAtMs, event.threadId, eventAtMs(event, nowMs));
    return;
  }
  if (isCompletedTurnEvent(event)) {
    recordLatest(ctx.memory.lastCompletedAtMs, event.threadId, eventAtMs(event, nowMs));
    return yield* settleEndedTurn(ctx, event, true);
  }
  if (isTurnEndedWithoutCompletion(event)) return yield* settleEndedTurn(ctx, event, false);
  const failure = failureFromRuntimeEvent(event, nowMs);
  if (failure) yield* recordTurnFailure(ctx, failure);
});

/**
 * A turn failed to start. A continuation's failure counts against its original intent. The
 * message's own intent settles either way: a turn that never started is never continued.
 */
const turnStartFailed = Effect.fn("recoveryTurnStartFailed")(function* (
  ctx: RecoveryContext,
  event: Extract<OrchestrationEvent, { type: "thread.turn-start-failed" }>,
) {
  const messageId = event.payload.messageId;
  if (messageId === undefined) return;
  const own = yield* ctx.intents.get({ threadId: event.payload.threadId, messageId });
  const originalId = Option.getOrUndefined(own)?.detail.continuationOf;
  if (originalId !== undefined) {
    const original = yield* ctx.intents.get({
      threadId: event.payload.threadId,
      messageId: originalId,
    });
    if (Option.isSome(original) && original.value.continuationMessageId === messageId) {
      yield* continuationFailed(ctx, original.value, event.payload.detail);
    }
  }
  if (Option.isSome(own) && own.value.disposition === "active") {
    yield* settleIntent(ctx, own.value);
  }
});

export const observeDomainEvent = Effect.fn("observeRecoveryDomainEvent")(function* (
  ctx: RecoveryContext,
  event: OrchestrationEvent,
) {
  switch (event.type) {
    case "thread.session-set": {
      if (SUPERVISOR_HEALTH_REASONS.has(event.payload.session.reason ?? "")) return;
      const failure = failureFromDomainEvent(event, ctx.nowMs());
      if (failure) yield* recordTurnFailure(ctx, failure);
      return;
    }
    case "thread.turn-start-failed":
      return yield* turnStartFailed(ctx, event);
    case "thread.recovery-updated": {
      const { resolvedAction, messageId, threadId } = event.payload;
      if (resolvedAction === undefined || messageId === undefined) return;
      return yield* resolveRecovery(ctx, { threadId, messageId, action: resolvedAction });
    }
    case "thread.turn-start-requested":
    case "thread.prompt-queued":
    case "thread.turn-interrupt-requested":
    case "thread.session-stop-requested":
      // User activity wins: the command transaction settled or revoked the intent.
      return yield* clearStaleNotice(ctx, event.payload.threadId);
    default:
      return;
  }
});

export const observeSleepEvent = Effect.fn("observeSleepEvent")(function* (
  ctx: RecoveryContext,
  event: SystemSleepEvent,
) {
  if (event.type === "epoch-ended") {
    yield* observeTurnsAcrossSleep(ctx, event.epoch);
    yield* classifyPendingFailures(ctx);
  }
  yield* runRecoveryPass(ctx);
});
