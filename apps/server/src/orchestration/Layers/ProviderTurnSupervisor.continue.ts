/**
 * Recovery effects: intent transitions, the visible `thread.recovery` projection, and the
 * linked continuation turn.
 *
 * A continuation is an ordinary server-originated `thread.turn.start` through the normal
 * command path, so it passes the pending-start gate and queue like any turn. It never
 * resends the original prompt.
 *
 * @module ProviderTurnSupervisor.continue
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationThread,
  type ThreadId,
} from "@bigbud/contracts";
import { Cause, Effect, Option } from "effect";

import type {
  ThreadRecoveryIntent,
  ThreadRecoveryIntentPatch,
} from "../../persistence/Services/ThreadRecoveryIntents.ts";
import {
  RECOVERY_MAX_ATTEMPTS,
  sameThreadRecovery,
  toThreadRecovery,
} from "./ProviderTurnSupervisor.policy.logic.ts";
import type { RecoveryContext } from "./ProviderTurnSupervisor.state.ts";

export const SLEEP_CONTINUATION_TEXT =
  "Your previous response was interrupted when the computer went to sleep. Continue the task from where it stopped. Do not repeat actions that already completed, and check the current state before relying on anything that may not have finished.";

const isoAt = (ctx: RecoveryContext) => new Date(ctx.nowMs()).toISOString();

const recoveryCommandId = (kind: string) =>
  CommandId.makeUnsafe(`server:sleep-recovery:${kind}:${crypto.randomUUID()}`);

/**
 * The thread from the read model, loaded on demand when it is not there. The startup window
 * holds only operational threads, so a thread whose session was persisted stopped (for
 * example after the old process's graceful `stopAll`) is missing until something loads it,
 * and its prompt would otherwise never be published. Undefined when it cannot be loaded.
 */
export const findThread = Effect.fn("findRecoveryThread")(function* (
  ctx: RecoveryContext,
  threadId: ThreadId,
) {
  const model = yield* ctx.engine.getReadModel();
  const loaded = model.threads.find((thread) => thread.id === threadId);
  if (loaded !== undefined || ctx.engine.ensureThreadState === undefined) return loaded;
  return yield* ctx.engine
    .ensureThreadState(threadId, "operational")
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("failed to load thread for sleep recovery", { threadId, cause }).pipe(
              Effect.as(undefined),
            ),
      ),
    );
});

/** Compare-and-set; returns the updated intent, or none when another writer won. */
export const transitionIntent = Effect.fn("transitionIntent")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
  patch: ThreadRecoveryIntentPatch,
) {
  const key = { threadId: intent.threadId, messageId: intent.messageId };
  const applied = yield* ctx.intents.transition({
    key,
    expectedRevision: intent.revision,
    patch,
    at: isoAt(ctx),
  });
  if (!applied) return Option.none<ThreadRecoveryIntent>();
  return yield* ctx.intents.get(key);
});

/**
 * Publishes the intent's visible state on its thread. A null state only clears a notice that
 * belongs to this intent, so an older intent can never wipe a newer prompt.
 */
export const publishRecovery = Effect.fn("publishRecovery")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
) {
  const thread = yield* findThread(ctx, intent.threadId);
  if (!thread || thread.deletedAt != null) return;
  const next = toThreadRecovery(intent, isoAt(ctx));
  const current = thread.recovery ?? null;
  if (next === null && current?.messageId !== intent.messageId) return;
  if (sameThreadRecovery(current, next)) return;
  yield* ctx.engine
    .dispatch({
      type: "thread.recovery.set",
      commandId: recoveryCommandId("set"),
      threadId: intent.threadId,
      recovery: next,
      messageId: intent.messageId,
      createdAt: isoAt(ctx),
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to publish thread recovery state", {
          threadId: intent.threadId,
          cause,
        }),
      ),
    );
});

/** Clears the thread's notice, but only while it still belongs to `messageId`. */
export const clearNoticeFor = Effect.fn("clearRecoveryNoticeFor")(function* (
  ctx: RecoveryContext,
  key: { readonly threadId: ThreadId; readonly messageId: MessageId },
) {
  const thread = yield* findThread(ctx, key.threadId);
  if (!thread || thread.deletedAt != null) return;
  if (thread.recovery?.messageId !== key.messageId) return;
  yield* ctx.engine
    .dispatch({
      type: "thread.recovery.set",
      commandId: recoveryCommandId("clear"),
      threadId: key.threadId,
      recovery: null,
      messageId: key.messageId,
      createdAt: isoAt(ctx),
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to clear thread recovery state", {
          threadId: key.threadId,
          cause,
        }),
      ),
    );
});

/** Notices that wait for the user's choice. */
export const USER_PROMPT_STATUSES: ReadonlySet<string> = new Set(["awaiting-user", "parked"]);

/**
 * Clears a notice whose intent is no longer active: user activity settled or revoked it, or
 * an exit suspended it. With `keepSuspendedPrompts`, a prompt waiting for the user stays,
 * because the user can still act on a suspended intent.
 */
export const clearStaleNotice = Effect.fn("clearStaleRecoveryNotice")(function* (
  ctx: RecoveryContext,
  threadId: ThreadId,
  options: { readonly keepSuspendedPrompts?: boolean } = {},
) {
  const thread = yield* findThread(ctx, threadId);
  const notice = thread?.recovery ?? null;
  if (notice === null) return;
  const intent = yield* ctx.intents.get({ threadId, messageId: notice.messageId });
  if (Option.isSome(intent)) {
    const { disposition } = intent.value;
    if (disposition === "active") return;
    if (
      options.keepSuspendedPrompts === true &&
      disposition === "suspended-for-exit" &&
      USER_PROMPT_STATUSES.has(notice.status)
    ) {
      return;
    }
  }
  yield* clearNoticeFor(ctx, { threadId, messageId: notice.messageId });
});

/**
 * Brings the thread's notice back in line with the intent after an action could not apply:
 * an active intent republishes its state, anything else clears its notice.
 */
export const resyncRecoveryNotice = Effect.fn("resyncRecoveryNotice")(function* (
  ctx: RecoveryContext,
  key: { readonly threadId: ThreadId; readonly messageId: MessageId },
) {
  const intent = yield* ctx.intents.get(key);
  if (Option.isSome(intent) && intent.value.disposition === "active") {
    return yield* publishRecovery(ctx, intent.value);
  }
  yield* clearNoticeFor(ctx, key);
});

/** Settles the intent and clears its notice. */
export const settleIntent = Effect.fn("settleIntent")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
  recoveryStatus: ThreadRecoveryIntent["recoveryStatus"] = intent.recoveryStatus,
) {
  const settled = yield* transitionIntent(ctx, intent, { disposition: "settled", recoveryStatus });
  if (Option.isSome(settled)) {
    yield* publishRecovery(ctx, { ...settled.value, recoveryStatus: "none" });
  }
});

/** Applies a transition and publishes the visible result. */
export const moveIntent = Effect.fn("moveIntent")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
  patch: ThreadRecoveryIntentPatch,
) {
  const moved = yield* transitionIntent(ctx, intent, patch);
  if (Option.isSome(moved)) yield* publishRecovery(ctx, moved.value);
  return moved;
});

function continuationCommand(input: {
  readonly thread: OrchestrationThread;
  readonly messageId: MessageId;
  readonly createdAt: string;
}) {
  return {
    type: "thread.turn.start" as const,
    commandId: recoveryCommandId("continue"),
    threadId: input.thread.id,
    message: {
      messageId: input.messageId,
      role: "user" as const,
      text: SLEEP_CONTINUATION_TEXT,
      attachments: [],
      originSegments: [
        {
          kind: "sleepRecovery" as const,
          actor: "automation" as const,
          text: SLEEP_CONTINUATION_TEXT,
          sourceThreads: [],
          verified: true,
        },
      ],
    },
    modelSelection: input.thread.modelSelection,
    runtimeMode: input.thread.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: input.thread.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: input.createdAt,
  };
}

/**
 * Sends one linked continuation for `intent`. Automatic sends count one attempt;
 * user-authorized Continue and Retry do not count toward parking.
 */
export const sendContinuation = Effect.fn("sendContinuation")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
  options: { readonly userAuthorized: boolean },
) {
  const thread = yield* findThread(ctx, intent.threadId);
  if (!thread || thread.deletedAt != null || thread.archivedAt != null) {
    return yield* settleIntent(ctx, intent);
  }
  const continuationId = MessageId.makeUnsafe(crypto.randomUUID());
  const createdAt = isoAt(ctx);
  const attemptCount = options.userAuthorized ? intent.attemptCount : intent.attemptCount + 1;
  const continuing = yield* transitionIntent(ctx, intent, {
    recoveryStatus: "continuing",
    attemptCount,
    lastAttemptAt: createdAt,
    continuationMessageId: continuationId,
    detail: {
      ...intent.detail,
      userAuthorized: options.userAuthorized,
      ...(options.userAuthorized
        ? { userAttemptCount: (intent.detail.userAttemptCount ?? 0) + 1 }
        : {}),
    },
  });
  if (Option.isNone(continuing)) return;
  // Pre-seed the continuation's own intent so a later sleep keeps counting the same attempts.
  yield* ctx.intents.recordAccepted({
    threadId: intent.threadId,
    messageId: continuationId,
    provider: intent.provider,
    createdAt,
    detail: { continuationOf: intent.messageId },
    attemptCount,
  });
  yield* publishRecovery(ctx, continuing.value);
  yield* Effect.logInfo("sending sleep recovery continuation", {
    threadId: intent.threadId,
    messageId: intent.messageId,
    continuationMessageId: continuationId,
    attempt: attemptCount,
    userAuthorized: options.userAuthorized,
  });
  const dispatched = yield* Effect.exit(
    ctx.engine.dispatch(continuationCommand({ thread, messageId: continuationId, createdAt })),
  );
  if (dispatched._tag === "Success") return;
  yield* continuationRejected(ctx, continuing.value, continuationId);
});

/**
 * The engine refused the continuation. The decider refuses one while the thread is busy, and
 * the command transaction refuses one whose original intent moved on, for example because the
 * user sent a message after the idle check. User activity wins: nothing is queued, and the
 * "Resuming" notice is cleared. Otherwise it counts as a failed continuation.
 */
const continuationRejected = Effect.fn("continuationRejected")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
  continuationId: MessageId,
) {
  // The pre-seeded intent of a continuation that never started must not stay open.
  const seeded = yield* ctx.intents.get({ threadId: intent.threadId, messageId: continuationId });
  if (Option.isSome(seeded) && seeded.value.disposition === "active") {
    yield* transitionIntent(ctx, seeded.value, { disposition: "settled" });
  }
  const current = yield* ctx.intents.get({
    threadId: intent.threadId,
    messageId: intent.messageId,
  });
  const stillWanted =
    Option.isSome(current) &&
    current.value.disposition === "active" &&
    current.value.recoveryStatus === "continuing" &&
    current.value.continuationMessageId === continuationId;
  if (stillWanted) {
    return yield* continuationFailed(ctx, current.value, "continuation was not accepted");
  }
  yield* Effect.logInfo("sleep recovery continuation dropped; the thread moved on", {
    threadId: intent.threadId,
    messageId: intent.messageId,
    continuationMessageId: continuationId,
  });
  yield* resyncRecoveryNotice(ctx, { threadId: intent.threadId, messageId: intent.messageId });
});

/** The continuation did not start. Count it and either retry later or park. */
export const continuationFailed = Effect.fn("continuationFailed")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
  detail: string,
) {
  if (intent.recoveryStatus !== "continuing") return;
  const exhausted = intent.attemptCount >= RECOVERY_MAX_ATTEMPTS;
  yield* Effect.logWarning("sleep recovery continuation failed", {
    threadId: intent.threadId,
    messageId: intent.messageId,
    attempt: intent.attemptCount,
    detail,
  });
  const nextDetail = {
    ...intent.detail,
    reason: "continuation-failed" as const,
    failureDetail: detail,
  };
  yield* moveIntent(ctx, intent, {
    recoveryStatus: exhausted
      ? "parked"
      : intent.detail.userAuthorized
        ? "awaiting-user"
        : "interrupted-by-sleep",
    detail: nextDetail,
  });
});

/** The continuation's turn bound: the original intent is done. */
export const continuationBound = Effect.fn("continuationBound")(function* (
  ctx: RecoveryContext,
  intent: ThreadRecoveryIntent,
) {
  if (intent.recoveryStatus !== "continuing") return;
  yield* settleIntent(ctx, intent, "continued");
});
