/**
 * What a backend start does with intents a previous process left behind.
 *
 * - After `resume-probe-restart` (Electron main restarted a backend that refused connections
 *   after wake), every unsettled intent whose latest dispatch may have reached the provider
 *   becomes an "outcome unknown" prompt (`backend-restarted-after-wake`) instead of a silent
 *   `stopped`.
 * - Any other start keeps today's behavior: the previous process's active intents are
 *   suspended, exactly as an app exit suspends them, and never resumed in this slice.
 *
 * Prompts already waiting for the user (awaiting-user, parked) stay as they are. Any other
 * notice whose intent is no longer active is cleared: an exit during a continuation
 * suspends its intent but leaves "Resuming after sleep" projected, and nothing else would
 * ever clear it.
 *
 * @module ProviderTurnSupervisor.startup
 */
import type { DesktopBackendStartReason } from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import { Effect, Option } from "effect";

import type { ThreadRecoveryIntent } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import {
  clearStaleNotice,
  moveIntent,
  publishRecovery,
  transitionIntent,
  USER_PROMPT_STATUSES,
} from "./ProviderTurnSupervisor.continue.ts";
import {
  forEachActiveIntent,
  forEachUncertainAfterRestart,
} from "./ProviderTurnSupervisor.intents.ts";
import type { RecoveryContext } from "./ProviderTurnSupervisor.state.ts";

/** A suspended intent counts as "the previous process's" only if it was suspended this recently. */
const PREVIOUS_SHUTDOWN_WINDOW_MS = 120_000;

const isBefore = (iso: string, ms: number) => {
  const at = Date.parse(iso);
  return Number.isFinite(at) && at < ms;
};

const promptAfterRestart = Effect.fn("promptAfterRestart")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
) {
  if (USER_PROMPT_STATUSES.has(intent.recoveryStatus)) {
    if (intent.disposition !== "active") {
      yield* moveIntent(ctx, intent, { disposition: "active" });
    }
    return;
  }
  yield* moveIntent(ctx, intent, {
    disposition: "active",
    recoveryStatus: "awaiting-user",
    detail: { ...intent.detail, reason: "backend-restarted-after-wake", userAuthorized: false },
  });
});

export const handleBackendStart = Effect.fn("handleRecoveryBackendStart")(function* (
  ctx: RecoveryContext,
  input: {
    readonly startReason: DesktopBackendStartReason | undefined;
    /** Wall time this process started; older rows belong to a previous process. */
    readonly processStartedAtMs: number;
  },
) {
  const { processStartedAtMs } = input;
  const prompted = new Set<string>();
  if (input.startReason === "resume-probe-restart") {
    yield* forEachUncertainAfterRestart(ctx, (intent) => {
      const previous =
        intent.disposition === "active"
          ? isBefore(intent.updatedAt, processStartedAtMs)
          : isBefore(intent.updatedAt, processStartedAtMs) &&
            !isBefore(intent.updatedAt, processStartedAtMs - PREVIOUS_SHUTDOWN_WINDOW_MS);
      if (!previous) return Effect.void;
      prompted.add(`${intent.threadId}\u0000${intent.messageId}`);
      return promptAfterRestart(ctx, intent);
    });
    yield* Effect.logInfo("backend restarted after wake; uncertain turns are prompts", {
      count: prompted.size,
    });
  }
  // Every leftover, not one page: an intent left active would never be suspended.
  yield* forEachActiveIntent(ctx, undefined, (intent) =>
    Effect.gen(function* () {
      if (prompted.has(`${intent.threadId}\u0000${intent.messageId}`)) return;
      if (!isBefore(intent.updatedAt, processStartedAtMs)) return;
      if (USER_PROMPT_STATUSES.has(intent.recoveryStatus)) return;
      const suspended = yield* transitionIntent(ctx, intent, { disposition: "suspended-for-exit" });
      if (Option.isSome(suspended)) {
        yield* publishRecovery(ctx, { ...suspended.value, recoveryStatus: "none" });
      }
    }),
  );
  const model = yield* ctx.engine.getReadModel();
  for (const thread of model.threads) {
    if (thread.recovery == null) continue;
    yield* clearStaleNotice(ctx, thread.id, { keepSuspendedPrompts: true });
  }
});
