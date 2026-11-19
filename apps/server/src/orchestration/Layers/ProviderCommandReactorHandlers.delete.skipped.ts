/**
 * Makes a thread deletion that was undone because the thread became active visible. The
 * deletion pipeline aborts it (`thread.delete.abort` clears the deleting state), so without this
 * the thread simply reappears: one structured warning for operators and drivers, and one thread
 * activity for the user, like the `thread.delete.failed` activity of a failed deletion.
 *
 * @module ProviderCommandReactorHandlers.delete.skipped
 */
import { EventId, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ThreadDeletionSkippedActiveReason } from "../../deletion/Services/ThreadDeletion.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";

export const THREAD_DELETE_SKIPPED_ACTIVITY_KIND = "thread.delete.skipped";

const SKIPPED_ACTIVE_SUMMARY: Record<ThreadDeletionSkippedActiveReason, string> = {
  "active-runtime": "Thread deletion was cancelled because the thread is running",
  "subtree-changed": "Thread deletion was cancelled because its threads changed while deleting",
};

export const reportSkippedActiveThreadDeletion = Effect.fn("reportSkippedActiveThreadDeletion")(
  function* (
    orchestrationEngine: OrchestrationEngineShape,
    input: {
      readonly rootThreadId: ThreadId;
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly reason: ThreadDeletionSkippedActiveReason;
      readonly mode: "single" | "subtree";
      readonly origin: string | undefined;
      readonly deletionEventId: string;
      readonly createdAt: string;
    },
  ) {
    yield* Effect.logWarning("thread deletion aborted: thread became active", {
      outcome: "skipped_active",
      reason: input.reason,
      rootThreadId: input.rootThreadId,
      threadIds: input.threadIds,
      mode: input.mode,
      origin: input.origin ?? "direct",
      deletionEventId: input.deletionEventId,
    });
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("thread-delete-skipped-activity"),
        threadId: input.rootThreadId,
        activity: {
          id: EventId.makeUnsafe(crypto.randomUUID()),
          tone: "info",
          kind: THREAD_DELETE_SKIPPED_ACTIVITY_KIND,
          summary: SKIPPED_ACTIVE_SUMMARY[input.reason],
          payload: { reason: input.reason, threadIds: input.threadIds },
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(
        Effect.asVoid,
        // The abort already happened; a lost notice must not turn it into a handler failure.
        Effect.catch((error) =>
          Effect.logWarning("could not record a skipped thread deletion activity", {
            rootThreadId: input.rootThreadId,
            detail: String(error),
          }),
        ),
      );
  },
);
