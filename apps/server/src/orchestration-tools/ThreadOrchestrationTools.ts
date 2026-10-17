import { CommandId, FAVORITE_THREAD_LIMIT, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { resolveThreadWorkflowStatus } from "../orchestration/ThreadWorkflowStatus.logic.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import { resolveThreadToolParticipants } from "./ThreadOrchestrationTools.participants.ts";

export const agentThreadCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`agent:${tag}:${crypto.randomUUID()}`);

export const archiveThreadViaOrchestration = Effect.fn("archiveThreadViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadId: ThreadId;
  }) {
    yield* input.orchestrationEngine.dispatch({
      type: "thread.archive",
      commandId: agentThreadCommandId("thread-archive"),
      threadId: input.threadId,
    });
    return { archived: true } as const;
  },
);

export const getThreadStatusViaOrchestration = Effect.fn("getThreadStatusViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
  }) {
    const { targetThread } = yield* resolveThreadToolParticipants({
      ...input,
      operation: "status",
    });

    return resolveThreadWorkflowStatus(targetThread);
  },
);

const requireCallerThread = Effect.fn("requirePinnedThreadToolCaller")(function* (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly callerThreadId: ThreadId;
}) {
  const readModel = yield* input.orchestrationEngine.getReadModel();
  const callerThread = readModel.threads.find((thread) => thread.id === input.callerThreadId);
  if (!callerThread) {
    return yield* Effect.fail(new Error("Caller thread could not be resolved."));
  }
  return readModel;
});

export const setThreadPinnedViaOrchestration = Effect.fn("setThreadPinnedViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
    readonly pinned: boolean;
  }) {
    const readModel = yield* requireCallerThread(input);
    const targetThread = readModel.threads.find((thread) => thread.id === input.threadId);

    if (input.pinned) {
      if (!targetThread || targetThread.deletedAt !== null) {
        return yield* Effect.fail(new Error(`Thread '${input.threadId}' was not found.`));
      }
      if (targetThread.deletingAt) {
        return yield* Effect.fail(new Error(`Thread '${input.threadId}' is being deleted.`));
      }
      if (targetThread.archivedAt !== null) {
        return yield* Effect.fail(new Error(`Thread '${input.threadId}' is archived.`));
      }
    }

    yield* input.orchestrationEngine.dispatch({
      type: input.pinned ? "thread.pin" : "thread.unpin",
      commandId: agentThreadCommandId(input.pinned ? "thread-pin" : "thread-unpin"),
      threadId: input.threadId,
    });
    const nextReadModel = yield* input.orchestrationEngine.getReadModel();
    const pinnedThreads = nextReadModel.threads.filter(
      (thread) => thread.deletedAt === null && (thread.pinnedAt ?? null) !== null,
    );
    const pinnedAt =
      nextReadModel.threads.find((thread) => thread.id === input.threadId)?.pinnedAt ?? null;
    return {
      threadId: input.threadId,
      pinned: input.pinned,
      pinnedAt,
      count: pinnedThreads.length,
      limit: FAVORITE_THREAD_LIMIT,
      remaining: FAVORITE_THREAD_LIMIT - pinnedThreads.length,
    } as const;
  },
);

export const listPinnedThreadsViaOrchestration = Effect.fn("listPinnedThreadsViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly callerThreadId: ThreadId;
  }) {
    const readModel = yield* requireCallerThread(input);
    const threads = readModel.threads
      .filter((thread) => thread.deletedAt === null && (thread.pinnedAt ?? null) !== null)
      .toSorted(
        (left, right) =>
          (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "") ||
          left.id.localeCompare(right.id),
      )
      .map((thread) => {
        const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
        return {
          threadId: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          projectTitle: project?.title ?? null,
          archived: thread.archivedAt !== null,
          available: true,
        };
      });

    return {
      count: threads.length,
      limit: FAVORITE_THREAD_LIMIT,
      remaining: FAVORITE_THREAD_LIMIT - threads.length,
      threads,
    } as const;
  },
);
