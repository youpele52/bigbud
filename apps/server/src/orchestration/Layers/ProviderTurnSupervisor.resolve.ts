/**
 * Acts on a user's `thread.recovery.resolve`. The decider already recorded the choice as a
 * `thread.recovery-updated` event with `resolvedAction`; this applies it to the intent.
 *
 * Continue and Retry send the same continuation as the automatic path, user-authorized, so
 * they do not count toward parking. Stop and continue first stops the provider turn.
 *
 * @module ProviderTurnSupervisor.resolve
 */
import type { MessageId, ThreadId } from "@bigbud/contracts";
import type { ThreadRecoveryResolveAction } from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { Effect, Option } from "effect";

import { isRecoveryActionApplicable } from "../deciderThreads.recovery.ts";
import { evaluateIntent } from "./ProviderTurnSupervisor.evaluate.ts";
import {
  resyncRecoveryNotice,
  settleIntent,
  transitionIntent,
} from "./ProviderTurnSupervisor.continue.ts";
import {
  RECOVERY_INSPECTION_TIMEOUT_MS,
  RECOVERY_STOP_SESSION_TIMEOUT_MS,
  type RecoveryContext,
} from "./ProviderTurnSupervisor.state.ts";

/**
 * Stops the provider turn for Stop and continue, outside the coordinator's permit. True only
 * when the provider answered the interrupt or its session stopped in time. Otherwise the turn
 * may still be running, and nothing may be sent after it.
 */
const stopProviderTurn = Effect.fn("stopProviderTurnForRecovery")(function* (
  ctx: RecoveryContext,
  threadId: ThreadId,
  turnId: Parameters<RecoveryContext["providerService"]["interruptTurn"]>[0]["turnId"],
) {
  const interrupted = yield* ctx.outsidePermit(
    ctx.providerService
      .interruptTurn({ threadId, ...(turnId ? { turnId } : {}) })
      .pipe(Effect.timeoutOption(RECOVERY_INSPECTION_TIMEOUT_MS), Effect.option),
  );
  if (Option.isSome(Option.flatten(interrupted))) return true;
  // The provider did not answer the interrupt; end its session so the thread can move on.
  const stopped = yield* ctx.outsidePermit(
    ctx.providerService
      .stopSession({ threadId })
      .pipe(Effect.timeoutOption(RECOVERY_STOP_SESSION_TIMEOUT_MS), Effect.option),
  );
  if (Option.isSome(Option.flatten(stopped))) return true;
  yield* Effect.logWarning("provider did not stop for sleep recovery; asking the user again", {
    threadId,
  });
  return false;
});

export const resolveRecovery = Effect.fn("resolveRecovery")(function* (
  ctx: RecoveryContext,
  input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly action: ThreadRecoveryResolveAction;
  },
) {
  const key = { threadId: input.threadId, messageId: input.messageId };
  const found = yield* ctx.intents.get(key);
  // The decider already projected the user's choice (for example "continuing"). When the
  // intent moved on meanwhile, that projection must not stay behind.
  if (
    Option.isNone(found) ||
    found.value.disposition === "revoked" ||
    found.value.disposition === "settled"
  ) {
    return yield* resyncRecoveryNotice(ctx, key);
  }
  const intent = found.value;
  // The decider saw the projection, which may lag the intent: a Continue on an intent that is
  // already continuing must not replace the continuation it is waiting to bind.
  if (!isRecoveryActionApplicable(input.action, intent.recoveryStatus)) {
    return yield* resyncRecoveryNotice(ctx, key);
  }
  yield* Effect.logInfo("sleep recovery resolved by user", {
    threadId: input.threadId,
    messageId: input.messageId,
    action: input.action,
  });
  switch (input.action) {
    case "dismiss":
      return yield* settleIntent(ctx, intent);
    case "keep-waiting": {
      // Restart the awake-time clock; the notice is already back to observing.
      const { reason: _previousReason, ...detail } = intent.detail;
      const waiting = yield* transitionIntent(ctx, intent, {
        disposition: "active",
        recoveryStatus: "observing",
        detail: { ...detail, wokeAt: new Date(ctx.nowMs()).toISOString() },
      });
      if (Option.isNone(waiting)) yield* resyncRecoveryNotice(ctx, key);
      return;
    }
    case "stop-and-continue": {
      const stopped = yield* stopProviderTurn(ctx, intent.threadId, intent.turnId ?? undefined);
      // The permit was released while stopping. Continue only from an unchanged intent, and
      // never after a stop that did not finish: the prompt stays for the user.
      const current = yield* ctx.intents.get(key);
      if (!stopped || Option.isNone(current) || current.value.revision !== intent.revision) {
        return yield* resyncRecoveryNotice(ctx, key);
      }
      break;
    }
    case "continue":
    case "retry":
      break;
  }
  const authorized = yield* transitionIntent(ctx, intent, {
    disposition: "active",
    recoveryStatus: "interrupted-by-sleep",
    // The awake-time clock restarts, so a slow stop is not reported as stuck right away.
    detail: { ...intent.detail, userAuthorized: true, wokeAt: new Date(ctx.nowMs()).toISOString() },
  });
  if (Option.isSome(authorized)) return yield* evaluateIntent(ctx, authorized.value);
  // Another writer won the compare-and-set; show what the intent is now.
  yield* resyncRecoveryNotice(ctx, key);
});
