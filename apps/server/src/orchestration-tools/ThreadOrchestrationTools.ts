import {
  CommandId,
  FAVORITE_THREAD_LIMIT,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { createHash } from "node:crypto";
import { Effect, Option } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { resolveThreadWorkflowStatus } from "../orchestration/ThreadWorkflowStatus.logic.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import type { ProjectionThreadWatchRepositoryShape } from "../persistence/Services/ProjectionThreadWatches.ts";
import { lockThreadTitle } from "./ThreadTitleLock.ts";

export const agentThreadCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`agent:${tag}:${crypto.randomUUID()}`);

const stableId = (prefix: string, value: string): string =>
  `${prefix}:${createHash("sha256").update(value).digest("hex")}`;

const delegationError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const createThreadViaOrchestration = Effect.fn("createThreadViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
    readonly projectionThreadWatchRepository: ProjectionThreadWatchRepositoryShape;
    readonly callerThreadId: ThreadId;
    readonly sourceMessageId: MessageId;
    readonly invocationId: string;
    readonly title: string;
    readonly task: string;
    readonly projectId?: ProjectId;
    readonly watchForCompletion: boolean;
  }) {
    const title = input.title.trim();
    const task = input.task.trim();
    const invocationId = input.invocationId.trim();
    if (title.length === 0 || title.length > 200) {
      return yield* Effect.fail(new Error("Thread title must be between 1 and 200 characters."));
    }
    if (task.length === 0 || task.length > 32_000) {
      return yield* Effect.fail(new Error("Thread task must be between 1 and 32000 characters."));
    }
    if (invocationId.length === 0) {
      return yield* Effect.fail(new Error("Invocation ID is required."));
    }

    const readModel = yield* input.orchestrationEngine.getReadModel();
    const callerThread = readModel.threads.find((thread) => thread.id === input.callerThreadId);
    if (!callerThread || callerThread.deletedAt !== null) {
      return yield* Effect.fail(new Error("Caller thread was not found."));
    }
    if (callerThread.deletingAt) {
      return yield* Effect.fail(new Error("Caller thread is being deleted."));
    }
    const targetProjectId = input.projectId ?? callerThread.projectId;
    const targetProject = readModel.projects.find((project) => project.id === targetProjectId);
    if (!targetProject || targetProject.deletedAt !== null) {
      return yield* Effect.fail(new Error(`Project '${targetProjectId}' was not found.`));
    }
    if (targetProject.deletingAt) {
      return yield* Effect.fail(new Error(`Project '${targetProjectId}' is being deleted.`));
    }

    const identity = `${input.callerThreadId}\n${input.sourceMessageId}\n${invocationId}`;
    const delegationId = stableId("delegation", identity);
    const childThreadId = ThreadId.makeUnsafe(stableId("thread", identity));
    const childTurnId = TurnId.makeUnsafe(stableId("turn", identity));
    const now = new Date().toISOString();
    const existing = yield* input.threadDelegationRepository
      .getByInvocation({
        callerThreadId: input.callerThreadId,
        sourceMessageId: input.sourceMessageId,
        invocationId,
      })
      .pipe(Effect.mapError(delegationError));
    const delegation = Option.isSome(existing)
      ? existing.value
      : yield* input.threadDelegationRepository
          .reserve({
            delegationId,
            callerThreadId: input.callerThreadId,
            sourceMessageId: input.sourceMessageId,
            invocationId,
            parentDelegationId: null,
            rootDelegationId: delegationId,
            depth: 0,
            targetKind: "project",
            targetProjectId,
            targetCanonicalWorkspace: null,
            childThreadId,
            childTurnId,
            createdProjectId: null,
            createdAt: now,
            updatedAt: now,
          })
          .pipe(Effect.mapError(delegationError));

    const child = readModel.threads.find((thread) => thread.id === delegation.childThreadId);
    if (delegation.state === "completed" || delegation.state === "watch_armed") {
      return {
        accepted: true,
        replayed: true,
        childThreadId: delegation.childThreadId,
        childTurnId: delegation.childTurnId,
        observedStatus: child ? resolveThreadWorkflowStatus(child) : null,
      } as const;
    }

    const parentThread = {
      threadId: callerThread.id,
      title: callerThread.title,
      projectId: callerThread.projectId,
    } as const;
    const provenance = [
      "<delegated_thread_provenance>",
      `Parent thread: ${parentThread.title} (${parentThread.threadId})`,
      `Parent project: ${parentThread.projectId}`,
      `Delegation: ${delegation.delegationId}`,
      "This is a delegated standalone thread. Complete the task below and report actionable results.",
      "</delegated_thread_provenance>",
      "",
      task,
    ].join("\n");

    const updateState = (
      state: Parameters<ThreadDelegationRepositoryShape["updateState"]>[0]["state"],
    ) =>
      input.threadDelegationRepository
        .updateState({
          delegationId: delegation.delegationId,
          state,
          updatedAt: new Date().toISOString(),
        })
        .pipe(Effect.mapError(delegationError));

    yield* updateState("project_resolved");
    const createResult = yield* input.orchestrationEngine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(stableId("command", `${identity}:create`)),
        threadId: delegation.childThreadId,
        projectId: targetProjectId,
        title,
        purpose: "standard",
        providerRuntimeExecutionTargetId: callerThread.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: callerThread.workspaceExecutionTargetId,
        executionTargetId: callerThread.executionTargetId,
        modelSelection: callerThread.modelSelection,
        runtimeMode: callerThread.runtimeMode,
        interactionMode: callerThread.interactionMode,
        branch: null,
        worktreePath: null,
        parentThread,
        createdAt: now,
      })
      .pipe(Effect.mapError(delegationError));
    yield* updateState("thread_accepted");
    const turnResult = yield* input.orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(stableId("command", `${identity}:turn`)),
        threadId: delegation.childThreadId,
        message: {
          messageId: input.sourceMessageId,
          role: "user",
          text: provenance,
          attachments: [],
        },
        modelSelection: callerThread.modelSelection,
        runtimeMode: callerThread.runtimeMode,
        interactionMode: callerThread.interactionMode,
        createdAt: now,
      })
      .pipe(Effect.mapError(delegationError));
    if (input.watchForCompletion) {
      yield* input.projectionThreadWatchRepository
        .addActiveWatch({
          watcherThreadId: input.callerThreadId,
          watchedThreadId: delegation.childThreadId,
          watchedThreadTitle: title,
          sourceMessageId: input.sourceMessageId,
          createdAt: now,
        })
        .pipe(
          Effect.mapError(delegationError),
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* input.threadDelegationRepository
                .storeResult({
                  delegationId: delegation.delegationId,
                  resultJson: null,
                  errorJson: JSON.stringify({ message: error.message }),
                  updatedAt: new Date().toISOString(),
                })
                .pipe(Effect.mapError(delegationError));
              yield* updateState("failed");
              return yield* Effect.fail(error);
            }),
          ),
        );
      yield* updateState("watch_armed");
    } else {
      yield* updateState("turn_accepted");
    }
    const result = {
      accepted: true,
      replayed: false,
      childThreadId: delegation.childThreadId,
      childTurnId: delegation.childTurnId,
      createSequence: createResult.sequence,
      turnSequence: turnResult.sequence,
      watchForCompletion: input.watchForCompletion,
    } as const;
    yield* input.threadDelegationRepository
      .storeResult({
        delegationId: delegation.delegationId,
        resultJson: JSON.stringify(result),
        errorJson: null,
        updatedAt: new Date().toISOString(),
      })
      .pipe(Effect.mapError(delegationError));
    yield* updateState("completed");
    const updatedReadModel = yield* input.orchestrationEngine.getReadModel();
    const updatedChild = updatedReadModel.threads.find(
      (thread) => thread.id === delegation.childThreadId,
    );
    return {
      ...result,
      observedStatus: updatedChild ? resolveThreadWorkflowStatus(updatedChild) : null,
    } as const;
  },
);

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
    readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
  }) {
    const readModel = yield* input.orchestrationEngine.getReadModel();
    const callerThread = readModel.threads.find((thread) => thread.id === input.callerThreadId);
    if (!callerThread || callerThread.deletedAt !== null) {
      return yield* Effect.fail(new Error("Caller thread could not be resolved."));
    }

    const targetThread = readModel.threads.find((thread) => thread.id === input.threadId);
    if (!targetThread || targetThread.deletedAt !== null) {
      return yield* Effect.fail(new Error(`Thread '${input.threadId}' was not found.`));
    }

    if (targetThread.projectId !== callerThread.projectId) {
      const delegation = yield* input.threadDelegationRepository
        .findDirectByChild({ childThreadId: targetThread.id })
        .pipe(Effect.mapError(delegationError));
      if (Option.isNone(delegation) || delegation.value.callerThreadId !== callerThread.id) {
        return yield* Effect.fail(
          new Error(`Thread '${input.threadId}' is not accessible from the current project.`),
        );
      }
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
