import {
  type ChatAttachment,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationThread,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type { ProjectionThreadWatchRepositoryShape } from "../persistence/Services/ProjectionThreadWatches.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import {
  resolveThreadWorkflowStatus,
  type ThreadWorkflowStatusSnapshot,
} from "./ThreadWorkflowStatus.logic.ts";

export function extractWatchedThreadAttachments(
  attachments: ReadonlyArray<ChatAttachment>,
  watcherThreadId: ThreadId,
): ReadonlyArray<Extract<ChatAttachment, { type: "thread" }>> {
  return attachments.filter(
    (attachment): attachment is Extract<ChatAttachment, { type: "thread" }> =>
      attachment.type === "thread" &&
      attachment.watchForCompletion === true &&
      attachment.threadId !== watcherThreadId,
  );
}

export function isThreadWorkflowComplete(thread: OrchestrationThread): boolean {
  return resolveThreadWorkflowStatus(thread).isWorkflowComplete;
}

export function isWatcherThreadBusy(thread: OrchestrationThread | undefined): boolean {
  if (!thread) {
    return true;
  }
  const status = resolveThreadWorkflowStatus(thread);
  return status.isAgentActive || status.hasPendingApprovals || status.hasPendingUserInput;
}

export function buildThreadWatchTriggerPrompt(input: {
  readonly completedThreads: ReadonlyArray<{
    readonly title: string;
    readonly threadId: ThreadId;
    readonly status: ThreadWorkflowStatusSnapshot;
  }>;
}): string {
  const lines = [
    "<watched_threads_completed>",
    "All threads you were watching from your prior message have finished their current work.",
    "Review their latest status below, then continue with any dependent work you were asked to do.",
    "",
  ];

  for (const thread of input.completedThreads) {
    lines.push(`## ${thread.title}`);
    lines.push(`- Thread ID: ${thread.threadId}`);
    lines.push(`- Workflow status: ${thread.status.workflowStatus}`);
    if (thread.status.lastAssistantExcerpt) {
      lines.push(`- Last assistant excerpt: ${thread.status.lastAssistantExcerpt}`);
    }
    lines.push("");
  }

  lines.push(
    "Use `get_thread_status` if you need a fresher read before acting.",
    "</watched_threads_completed>",
  );
  return lines.join("\n");
}

export const registerThreadWatchesFromAttachments = Effect.fn(
  "registerThreadWatchesFromAttachments",
)(function* (input: {
  readonly repository: ProjectionThreadWatchRepositoryShape;
  readonly watcherThreadId: ThreadId;
  readonly sourceMessageId: MessageId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly createdAt: string;
}) {
  const watches = extractWatchedThreadAttachments(input.attachments, input.watcherThreadId).map(
    (attachment) => ({
      watchedThreadId: ThreadId.makeUnsafe(attachment.threadId),
      watchedThreadTitle: attachment.title,
    }),
  );

  yield* input.repository.replaceActiveWatchesForMessage({
    watcherThreadId: input.watcherThreadId,
    sourceMessageId: input.sourceMessageId,
    watches,
    createdAt: input.createdAt,
  });
});

export const dispatchThreadWatchTriggerTurn = Effect.fn("dispatchThreadWatchTriggerTurn")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly watcherThread: OrchestrationThread;
    readonly completedThreads: ReadonlyArray<{
      readonly title: string;
      readonly threadId: ThreadId;
      readonly status: ThreadWorkflowStatusSnapshot;
    }>;
    readonly createdAt: string;
  }) {
    const messageId = MessageId.makeUnsafe(crypto.randomUUID());
    const commandId = CommandId.makeUnsafe(`server:thread-watch:${crypto.randomUUID()}`);
    const attachments = input.completedThreads.map((thread) => ({
      type: "thread" as const,
      id: `watch-trigger-${thread.threadId}`,
      name: thread.title,
      mimeType: "application/x-bigbud-thread-reference" as const,
      sizeBytes: 0 as const,
      threadId: thread.threadId,
      title: thread.title,
      watchForCompletion: false,
    }));

    yield* input.orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId,
      threadId: input.watcherThread.id,
      message: {
        messageId,
        role: "user",
        text: buildThreadWatchTriggerPrompt({ completedThreads: input.completedThreads }),
        attachments,
      },
      ...(input.watcherThread.modelSelection !== undefined
        ? { modelSelection: input.watcherThread.modelSelection }
        : {}),
      runtimeMode: input.watcherThread.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      interactionMode: input.watcherThread.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: input.createdAt,
    });
  },
);

export function groupActiveWatchesByTriggerKey<
  T extends { readonly watcherThreadId: ThreadId; readonly sourceMessageId: MessageId },
>(watches: ReadonlyArray<T>): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const watch of watches) {
    const key = `${watch.watcherThreadId}:${watch.sourceMessageId}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(watch);
    grouped.set(key, bucket);
  }
  return grouped;
}
