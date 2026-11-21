/**
 * Undoes a thread deletion that did not complete. The `thread.deletion-failed` event carries the
 * user-facing reason, so clients can say exactly what kept the thread instead of a generic
 * "safety check or cleanup failure"; failed and skipped outcomes keep their thread activities.
 *
 * @module ProviderCommandReactorHandlers.delete.abort
 */
import type { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ThreadDeletionOutcome } from "../../deletion/Services/ThreadDeletion.ts";
import { isRetentionDeletionCommandId } from "../../deletion/Services/ThreadDeletion.mode.ts";
import { DELETION_FAILURE_DETAIL_MAX_LENGTH } from "../../deletion/Layers/DeletionFailure.detail.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { appendDeletionFailureActivity } from "./ProviderCommandReactorHandlers.delete.cleanup.ts";
import {
  reportSkippedActiveThreadDeletion,
  SKIPPED_ACTIVE_SUMMARY,
} from "./ProviderCommandReactorHandlers.delete.skipped.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";

export type UndoneThreadDeletionOutcome = Exclude<ThreadDeletionOutcome, { type: "deleted" }>;

const PINNED_REASON = "Pinned threads are not deleted. Unpin the thread first.";
const FALLBACK_REASON = "Thread deletion failed for an unknown reason.";

/** The reason stored on `thread.deletion-failed`: trimmed, non-empty and bounded. */
export function threadDeletionAbortReason(outcome: UndoneThreadDeletionOutcome): string {
  const reason =
    outcome.type === "failed"
      ? outcome.detail.trim()
      : outcome.type === "skipped_pinned"
        ? PINNED_REASON
        : `${SKIPPED_ACTIVE_SUMMARY[outcome.reason]}.`;
  if (reason.length === 0) return FALLBACK_REASON;
  return reason.length > DELETION_FAILURE_DETAIL_MAX_LENGTH
    ? `${reason.slice(0, DELETION_FAILURE_DETAIL_MAX_LENGTH - 1)}…`
    : reason;
}

export const abortThreadDeletion = Effect.fn("abortThreadDeletion")(function* (
  orchestrationEngine: OrchestrationEngineShape,
  input: {
    readonly threadId: ThreadId;
    readonly mode: "single" | "subtree";
    readonly origin: string | undefined;
    readonly deletionEventId: string;
    /** Command that requested the deletion; identifies background retention requests. */
    readonly deletionCommandId: string | null;
    readonly createdAt: string;
    readonly outcome: UndoneThreadDeletionOutcome;
  },
) {
  const { outcome } = input;
  const reason = threadDeletionAbortReason(outcome);
  const retention = isRetentionDeletionCommandId(input.deletionCommandId);
  if (retention) {
    // Nobody is waiting on a background deletion: the run records it as failed, the thread keeps
    // its activity, and clients do not raise a toast for it.
    yield* Effect.logWarning("thread retention deletion was undone", {
      threadId: input.threadId,
      outcome: outcome.type,
      reason,
    });
  }
  yield* orchestrationEngine.dispatch({
    type: "thread.delete.abort",
    commandId: serverCommandId("thread-delete-abort"),
    threadId: input.threadId,
    mode: input.mode,
    reason,
    ...(retention ? { initiator: "retention" as const } : {}),
    createdAt: input.createdAt,
  });
  if (outcome.type === "failed") {
    yield* appendDeletionFailureActivity(orchestrationEngine, {
      threadId: input.threadId,
      createdAt: input.createdAt,
      detail: outcome.detail,
    });
  } else if (outcome.type === "skipped_active") {
    yield* reportSkippedActiveThreadDeletion(orchestrationEngine, {
      rootThreadId: input.threadId,
      threadIds: outcome.threadIds,
      reason: outcome.reason,
      mode: input.mode,
      origin: input.origin,
      deletionEventId: input.deletionEventId,
      createdAt: input.createdAt,
    });
  }
});
