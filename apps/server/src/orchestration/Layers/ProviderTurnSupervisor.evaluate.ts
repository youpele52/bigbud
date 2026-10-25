/**
 * Applies the recovery policy to one intent: gathers the facts (inspection, progress, tools in
 * flight, network, idleness) and performs the decision.
 *
 * @module ProviderTurnSupervisor.evaluate
 */
import type { OrchestrationThread } from "@bigbud/contracts";
import type { ProviderTurnLiveness } from "@bigbud/contracts/orchestration/providerTurnLiveness";
import { Effect, Option } from "effect";

import type { ThreadRecoveryIntent } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import {
  isThreadConfirmedIdleForDispatch,
  isThreadWaitingForUser,
} from "../ThreadDispatchSafety.logic.ts";
import {
  REMOTE_SHELL_TOOL_LABEL,
  summarizeToolsInFlight,
} from "./ProviderTurnSupervisor.classify.logic.ts";
import {
  continuationBound,
  continuationFailed,
  findThread,
  moveIntent,
  publishRecovery,
  sendContinuation,
  settleIntent,
} from "./ProviderTurnSupervisor.continue.ts";
import {
  decideRecovery,
  isProgressAfterWake,
  type InspectionOutcome,
} from "./ProviderTurnSupervisor.policy.logic.ts";
import {
  intentKeyString,
  RECOVERY_INSPECTION_INTERVAL_MS,
  RECOVERY_INSPECTION_TIMEOUT_MS,
  setBounded,
  type RecoveryContext,
} from "./ProviderTurnSupervisor.state.ts";
import { toolsInFlightForTurn } from "./ProviderTurnSupervisor.tools.logic.ts";

/** A continuation start that never binds or fails is failed after the pending-start watchdog. */
const CONTINUATION_BIND_TIMEOUT_MS = 11 * 60_000;

/**
 * The provider's view of the intent's turn. The call runs outside the coordinator's permit
 * (`released`); a result is cached for the intent revision it was taken at, so it never
 * outlives a transition.
 */
const inspect = Effect.fn("inspectRecoveringTurn")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
  thread: OrchestrationThread,
) {
  if (intent.turnId === null) return { outcome: null, released: false };
  const key = intentKeyString(intent.threadId, intent.messageId);
  const cached = ctx.memory.inspections.get(key);
  const nowMs = ctx.nowMs();
  if (
    cached &&
    cached.revision === intent.revision &&
    nowMs - cached.atMs < RECOVERY_INSPECTION_INTERVAL_MS
  ) {
    return { outcome: cached.outcome, released: false };
  }
  const result = yield* ctx.outsidePermit(
    ctx.providerService
      .inspectActiveTurn({
        threadId: intent.threadId,
        turnId: intent.turnId,
        sessionEpoch: thread.session?.sessionEpoch ?? 0,
      })
      .pipe(Effect.timeoutOption(RECOVERY_INSPECTION_TIMEOUT_MS), Effect.option),
  );
  const outcome = Option.getOrUndefined(Option.flatten(result))?.status ?? null;
  const known: InspectionOutcome | null = outcome as InspectionOutcome | null;
  setBounded(
    ctx.memory.inspections,
    key,
    { atMs: nowMs, revision: intent.revision, outcome: known },
    1_024,
  );
  return { outcome: known, released: true };
});

const terminalLiveness = (
  liveness: ReadonlyArray<ProviderTurnLiveness>,
  intent: ThreadRecoveryIntent,
) =>
  intent.turnId !== null &&
  !liveness.some((row) => row.threadId === intent.threadId && row.turnId === intent.turnId);

/** Every tool that may have been running in the intent's turn, local or remote. */
const toolsInFlight = Effect.fn("recoveryToolsInFlight")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
  thread: OrchestrationThread,
) {
  const remoteShell = yield* ctx.intents.hasUncertainRemoteShell(intent.threadId);
  return summarizeToolsInFlight([
    ...toolsInFlightForTurn({
      activities: thread.activities,
      turnId: intent.turnId,
      since: intent.createdAt,
      tracking: ctx.memory.turnTools.get(intent.threadId),
    }),
    ...(remoteShell ? [REMOTE_SHELL_TOOL_LABEL] : []),
  ]);
});

/** A continuation in flight: it binds, fails, or times out. */
const evaluateContinuing = Effect.fn("evaluateContinuingIntent")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
) {
  const continuation =
    intent.continuationMessageId === null
      ? Option.none()
      : yield* ctx.intents.get({
          threadId: intent.threadId,
          messageId: intent.continuationMessageId,
        });
  if (Option.isSome(continuation) && continuation.value.turnId !== null) {
    return yield* continuationBound(ctx, intent);
  }
  const sentAtMs = Date.parse(intent.lastAttemptAt ?? "");
  if (Number.isFinite(sentAtMs) && ctx.nowMs() - sentAtMs > CONTINUATION_BIND_TIMEOUT_MS) {
    return yield* continuationFailed(ctx, intent, "continuation never started");
  }
});

/** Applies the policy to one intent in recovery. */
export const evaluateIntent = Effect.fn("evaluateRecoveryIntent")(function* (
  ctx: RecoveryContext,
  listed: ThreadRecoveryIntent,
  liveness?: ReadonlyArray<ProviderTurnLiveness>,
) {
  const before = yield* findThread(ctx, listed.threadId);
  // A thread that cannot be loaded is left alone; deletion revokes its intents.
  if (!before) return;
  if (before.deletedAt != null) return yield* settleIntent(ctx, listed);
  if (listed.recoveryStatus === "continuing") return yield* evaluateContinuing(ctx, listed);
  const inspection = yield* inspect(ctx, listed, before);
  // The inspection may have released the permit: act only on the intent as it is now. A
  // newer revision is evaluated by the next pass, never with this stale view.
  const current = yield* ctx.intents.get({
    threadId: listed.threadId,
    messageId: listed.messageId,
  });
  if (Option.isNone(current) || current.value.revision !== listed.revision) return;
  const intent = current.value;
  const thread = yield* findThread(ctx, intent.threadId);
  if (!thread) return;
  const nowMs = ctx.nowMs();
  const wokeAtMs = intent.detail.wokeAt ? Date.parse(intent.detail.wokeAt) : null;
  const rows =
    liveness !== undefined && !inspection.released
      ? liveness
      : yield* ctx.providerService.listActiveTurnLiveness();
  const completedAtMs = ctx.memory.lastCompletedAtMs.get(intent.threadId) ?? null;
  const lastProgressAtMs = ctx.memory.lastProgressAtMs.get(intent.threadId) ?? null;
  const decision = decideRecovery({
    intent,
    nowMs,
    wokeAtMs,
    inspection: inspection.outcome,
    progressAfterWake: isProgressAfterWake(lastProgressAtMs, wokeAtMs),
    lastProgressAtMs,
    turnCompleted:
      completedAtMs !== null &&
      completedAtMs >= Date.parse(intent.createdAt) &&
      terminalLiveness(rows, intent),
    toolInFlight: yield* toolsInFlight(ctx, intent, thread),
    networkOnline: Option.isSome(ctx.sleep) ? yield* ctx.sleep.value.networkOnline : null,
    continuationEnabled: ctx.continuationEnabled,
    threadIdle: isThreadConfirmedIdleForDispatch(thread),
    waitingForUser: isThreadWaitingForUser(thread),
  });
  switch (decision.type) {
    case "settle":
      return yield* settleIntent(ctx, intent);
    case "provider-continued":
      yield* moveIntent(ctx, intent, {
        recoveryStatus: "provider-continued",
        detail: { ...intent.detail, reason: "provider-continued" },
      });
      return;
    case "continue":
      return yield* sendContinuation(ctx, intent, {
        userAuthorized: intent.detail.userAuthorized === true,
      });
    case "park":
      yield* moveIntent(ctx, intent, {
        recoveryStatus: "parked",
        detail: { ...intent.detail, reason: "continuation-failed" },
      });
      return;
    case "await-user":
      yield* moveIntent(ctx, intent, {
        recoveryStatus: "awaiting-user",
        detail: {
          ...intent.detail,
          reason: decision.reason,
          ...(decision.toolSummary ? { toolSummary: decision.toolSummary } : {}),
        },
      });
      return;
    case "wait-network":
    case "none":
      if (intent.recoveryStatus === "interrupted-by-sleep") yield* publishRecovery(ctx, intent);
      return;
  }
});
