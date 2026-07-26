import { CommandId, FAVORITE_THREAD_LIMIT, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { resolveThreadWorkflowStatus } from "../orchestration/ThreadWorkflowStatus.logic.ts";
import type { ServerSettingsShape } from "../ws/serverSettings.ts";
import { lockThreadTitle } from "./ThreadTitleLock.ts";

export const agentThreadCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`agent:${tag}:${crypto.randomUUID()}`);

export const renameThreadViaOrchestration = Effect.fn("renameThreadViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadId: ThreadId;
    readonly title: string;
  }) {
    const trimmed = input.title.trim();
    if (trimmed.length === 0) {
      return yield* Effect.fail(new Error("Thread title cannot be empty."));
    }

    yield* input.orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: agentThreadCommandId("thread-rename"),
      threadId: input.threadId,
      title: trimmed,
    });
    lockThreadTitle(input.threadId);
    return { title: trimmed } as const;
  },
);

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
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
  }) {
    const readModel = yield* input.orchestrationEngine.getReadModel();
    const callerThread = readModel.threads.find((thread) => thread.id === input.callerThreadId);
    if (!callerThread) {
      return yield* Effect.fail(new Error("Caller thread could not be resolved."));
    }

    const targetThread = readModel.threads.find((thread) => thread.id === input.threadId);
    if (!targetThread) {
      return yield* Effect.fail(new Error(`Thread '${input.threadId}' was not found.`));
    }
    if (targetThread.projectId !== callerThread.projectId) {
      return yield* Effect.fail(
        new Error(`Thread '${input.threadId}' is not accessible from the current project.`),
      );
    }

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
    readonly serverSettings: ServerSettingsShape;
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

    const settings = yield* input.serverSettings.setThreadPinned({
      threadId: input.threadId,
      pinned: input.pinned,
    });
    return {
      threadId: input.threadId,
      pinned: input.pinned,
      count: settings.favoriteThreadIds.length,
      limit: FAVORITE_THREAD_LIMIT,
      remaining: FAVORITE_THREAD_LIMIT - settings.favoriteThreadIds.length,
    } as const;
  },
);

export const listPinnedThreadsViaOrchestration = Effect.fn("listPinnedThreadsViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly serverSettings: ServerSettingsShape;
    readonly callerThreadId: ThreadId;
  }) {
    const readModel = yield* requireCallerThread(input);
    const settings = yield* input.serverSettings.getSettings;

    const threads = settings.favoriteThreadIds.map((threadId) => {
      const thread = readModel.threads.find((candidate) => candidate.id === threadId);
      const project = thread
        ? readModel.projects.find((candidate) => candidate.id === thread.projectId)
        : undefined;
      return {
        threadId,
        title: thread?.title ?? null,
        projectId: thread?.projectId ?? null,
        projectTitle: project?.title ?? null,
        archived: thread ? thread.archivedAt !== null : null,
        available: Boolean(thread && thread.deletedAt === null),
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
