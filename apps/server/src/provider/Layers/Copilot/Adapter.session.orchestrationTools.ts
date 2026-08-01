/**
 * Binds the shared thread orchestration tool dispatcher to the Copilot SDK tool
 * surface. Split from `Adapter.session.start.ts` to keep that module under the
 * file length limit.
 */
import { MessageId, ProjectId, ThreadId, type ThreadId as ThreadIdType } from "@bigbud/contracts";
import { Effect } from "effect";

import { createCopilotThreadOrchestrationTools } from "../../../orchestration-tools/copilotThreadOrchestrationTools.ts";
import type { ThreadOrchestrationToolDispatcherShape } from "../../../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";

const asRecord = <A>(effect: Effect.Effect<A, Error>) =>
  Effect.runPromise(
    effect.pipe(Effect.map((result) => result as unknown as Record<string, unknown>)),
  );

export function createCopilotOrchestrationToolSurface(input: {
  readonly dispatcher: ThreadOrchestrationToolDispatcherShape;
  readonly threadId: ThreadIdType;
}) {
  const { dispatcher, threadId } = input;
  const listThreadsDispatch = dispatcher.listThreads;
  return createCopilotThreadOrchestrationTools({
    renameThread: (title) => Effect.runPromise(dispatcher.rename({ threadId, title })),
    archiveThread: () => Effect.runPromise(dispatcher.archive({ threadId }).pipe(Effect.asVoid)),
    getThreadStatus: (targetThreadId) =>
      asRecord(
        dispatcher.getStatus({
          callerThreadId: threadId,
          threadId: ThreadId.makeUnsafe(targetThreadId),
        }),
      ),
    listPinnedThreads: () => asRecord(dispatcher.listPinned({ callerThreadId: threadId })),
    ...(listThreadsDispatch
      ? {
          listThreads: (listInput: {
            readonly projectId?: string;
            readonly status: Parameters<typeof listThreadsDispatch>[0]["status"];
            readonly limit?: number;
            readonly includeExcerpt: boolean;
          }) =>
            asRecord(
              listThreadsDispatch({
                callerThreadId: threadId,
                ...(listInput.projectId
                  ? { projectId: ProjectId.makeUnsafe(listInput.projectId) }
                  : {}),
                status: listInput.status,
                ...(listInput.limit !== undefined ? { limit: listInput.limit } : {}),
                includeExcerpt: listInput.includeExcerpt,
              }),
            ),
        }
      : {}),
    setThreadPinned: (targetThreadId, pinned) =>
      asRecord(
        dispatcher.setPinned({
          callerThreadId: threadId,
          threadId: ThreadId.makeUnsafe(targetThreadId),
          pinned,
        }),
      ),
    computerUse: (action) => asRecord(dispatcher.computerUse({ threadId, action })),
    browser: (action) => asRecord(dispatcher.browser({ threadId, action })),
    createThread: ({ invocationId, sourceMessageId, title, task, projectId, watchForCompletion }) =>
      asRecord(
        dispatcher.createThread?.({
          callerThreadId: threadId,
          sourceMessageId: MessageId.makeUnsafe(sourceMessageId),
          invocationId,
          title,
          task,
          ...(projectId ? { projectId: ProjectId.makeUnsafe(projectId) } : {}),
          watchForCompletion,
        }) ?? Effect.fail(new Error("Thread creation is not ready.")),
      ),
    sendThreadMessage: ({ threadId: targetThreadId, message, delivery, invocationId }) =>
      asRecord(
        dispatcher.sendMessage?.({
          callerThreadId: threadId,
          threadId: ThreadId.makeUnsafe(targetThreadId),
          message,
          delivery,
          invocationId,
        }) ?? Effect.fail(new Error("Thread messaging is not ready.")),
      ),
  });
}
