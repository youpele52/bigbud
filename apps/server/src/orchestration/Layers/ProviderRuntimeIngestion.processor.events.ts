import {
  CheckpointRef,
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationTask,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTaskCompletedEvent,
  type ProviderRuntimeTaskProgressEvent,
  type ProviderRuntimeTaskRemovedEvent,
  type ProviderRuntimeTaskStartedEvent,
  type ProviderRuntimeTaskUpdatedEvent,
} from "@bigbud/contracts";
import { mergeTaskPatch } from "@bigbud/shared/providerRuntime";
import { Effect } from "effect";

import { isThinkingActivity } from "./ProviderRuntimeIngestion.processor.thinking.ts";
import { toTurnId } from "./ProviderRuntimeIngestion.helpers.ts";
import type { RuntimeProcessorServices } from "./ProviderRuntimeIngestion.processor.ts";
import { isThreadTitleLocked } from "../../orchestration-tools/ThreadTitleLock.ts";

export type TaskRuntimeEvent =
  | ProviderRuntimeTaskStartedEvent
  | ProviderRuntimeTaskProgressEvent
  | ProviderRuntimeTaskCompletedEvent
  | ProviderRuntimeTaskUpdatedEvent
  | ProviderRuntimeTaskRemovedEvent;

export function makeRuntimeProcessorEventHelpers(input: {
  readonly orchestrationEngine: RuntimeProcessorServices["orchestrationEngine"];
  readonly serverSettingsService: RuntimeProcessorServices["serverSettingsService"];
  readonly isGitRepoForThread: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly providerCommandId: (event: ProviderRuntimeEvent, tag: string) => CommandId;
}) {
  const appendActivities = Effect.fn("appendActivities")(function* (deps: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  }) {
    const thinkingStreamingEnabled =
      !deps.activities.some(isThinkingActivity) ||
      (yield* input.serverSettingsService.getSettings.pipe(
        Effect.map((settings) => settings.enableThinkingStreaming),
        Effect.catch(() => Effect.succeed(false)),
      ));
    yield* Effect.forEach(
      deps.activities,
      (activity) =>
        thinkingStreamingEnabled || !isThinkingActivity(activity)
          ? input.orchestrationEngine
              .dispatch({
                type: "thread.activity.append",
                commandId: input.providerCommandId(deps.event, "thread-activity-append"),
                threadId: deps.threadId,
                activity,
                createdAt: activity.createdAt,
              })
              .pipe(Effect.asVoid)
          : Effect.void,
      { concurrency: 1, discard: true },
    );
  });

  const handleTurnDiffUpdated = Effect.fn("handleTurnDiffUpdated")(function* (deps: {
    readonly event: Extract<ProviderRuntimeEvent, { type: "turn.diff.updated" }>;
    readonly thread: {
      readonly id: ThreadId;
      readonly checkpoints: ReadonlyArray<{
        readonly turnId: string | null;
        readonly checkpointTurnCount: number;
      }>;
    };
    readonly now: string;
  }) {
    const turnId = toTurnId(deps.event.turnId);
    if (!turnId || !(yield* input.isGitRepoForThread(deps.thread.id))) {
      return;
    }

    if (deps.thread.checkpoints.some((c) => c.turnId === turnId)) {
      return;
    }

    const assistantMessageId = MessageId.makeUnsafe(
      `assistant:${deps.event.itemId ?? deps.event.turnId ?? deps.event.eventId}`,
    );
    const maxTurnCount = deps.thread.checkpoints.reduce(
      (max, c) => Math.max(max, c.checkpointTurnCount),
      0,
    );
    yield* input.orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: input.providerCommandId(deps.event, "thread-turn-diff-complete"),
      threadId: deps.thread.id,
      turnId,
      completedAt: deps.now,
      checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${deps.event.eventId}`),
      status: "missing",
      files: [],
      assistantMessageId,
      checkpointTurnCount: maxTurnCount + 1,
      createdAt: deps.now,
    });
  });

  const handleThreadMetadataUpdated = Effect.fn("handleThreadMetadataUpdated")(function* (deps: {
    readonly event: Extract<ProviderRuntimeEvent, { type: "thread.metadata.updated" }>;
    readonly threadId: ThreadId;
  }) {
    if (!deps.event.payload.name || isThreadTitleLocked(deps.threadId)) return;
    yield* input.orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: input.providerCommandId(deps.event, "thread-meta-update"),
      threadId: deps.threadId,
      title: deps.event.payload.name,
    });
  });

  const upsertTask = Effect.fn("upsertTask")(function* (deps: {
    readonly event: TaskRuntimeEvent;
    readonly threadId: ThreadId;
    readonly ordinal?: number;
  }) {
    const currentTasks =
      (yield* input.orchestrationEngine.getReadModel()).threads.find(
        (thread) => thread.id === deps.threadId,
      )?.tasks ?? [];
    const previous = currentTasks.find((task) => task.id === deps.event.payload.taskId);
    const lifecycleStatus =
      deps.event.type === "task.completed"
        ? deps.event.payload.status === "completed"
          ? "completed"
          : deps.event.payload.status === "failed"
            ? "failed"
            : "stopped"
        : deps.event.type === "task.progress"
          ? "inProgress"
          : "pending";
    const task: OrchestrationTask =
      deps.event.type === "task.updated"
        ? {
            id: deps.event.payload.taskId,
            status: deps.event.payload.status,
            subject: deps.event.payload.subject,
            ...(deps.event.payload.description
              ? { description: deps.event.payload.description }
              : previous?.description
                ? { description: previous.description }
                : {}),
            ...(deps.event.payload.activeLabel
              ? { activeLabel: deps.event.payload.activeLabel }
              : {}),
            ...(deps.event.payload.sourceToolUseId
              ? { sourceToolUseId: deps.event.payload.sourceToolUseId }
              : previous?.sourceToolUseId
                ? { sourceToolUseId: previous.sourceToolUseId }
                : {}),
            ...(deps.event.payload.requestId ? { requestId: deps.event.payload.requestId } : {}),
            ...(deps.event.payload.agentId ? { agentId: deps.event.payload.agentId } : {}),
            ...(deps.event.payload.parentAgentId
              ? { parentAgentId: deps.event.payload.parentAgentId }
              : {}),
            ...(deps.event.payload.parentToolUseId
              ? { parentToolUseId: deps.event.payload.parentToolUseId }
              : {}),
            ...(deps.event.payload.parentTaskId
              ? { parentTaskId: deps.event.payload.parentTaskId }
              : {}),
            ...(deps.event.payload.subagentType
              ? { subagentType: deps.event.payload.subagentType }
              : {}),
            ...(deps.event.payload.background !== undefined
              ? { background: deps.event.payload.background }
              : {}),
            ...(deps.event.payload.blockedBy ? { blockedBy: deps.event.payload.blockedBy } : {}),
            ...(deps.event.payload.progressSummary
              ? { progressSummary: deps.event.payload.progressSummary }
              : {}),
            ...(deps.event.payload.lastToolName
              ? { lastToolName: deps.event.payload.lastToolName }
              : {}),
            ...(deps.event.payload.usage !== undefined ? { usage: deps.event.payload.usage } : {}),
            ...(deps.event.payload.terminalReason
              ? { terminalReason: deps.event.payload.terminalReason }
              : {}),
            ...(deps.event.payload.turnId
              ? { turnId: deps.event.payload.turnId }
              : previous?.turnId
                ? { turnId: previous.turnId }
                : {}),
            ...(deps.event.payload.order !== undefined
              ? { order: deps.event.payload.order }
              : previous?.order !== undefined
                ? { order: previous.order }
                : {}),
            ...(deps.event.payload.membership
              ? { membership: deps.event.payload.membership }
              : previous?.membership
                ? { membership: previous.membership }
                : {}),
            source: deps.event.payload.source,
            freshness: deps.event.payload.freshness,
            createdAt: previous?.createdAt ?? deps.event.payload.createdAt ?? deps.event.createdAt,
            updatedAt: deps.event.createdAt,
          }
        : {
            ...previous,
            id: deps.event.payload.taskId,
            status: lifecycleStatus,
            subject:
              deps.event.type === "task.progress"
                ? deps.event.payload.description
                : deps.event.type === "task.started"
                  ? (deps.event.payload.description ?? previous?.subject ?? "Task")
                  : (previous?.subject ?? "Task"),
            ...(deps.event.type === "task.progress" && deps.event.payload.summary
              ? { progressSummary: deps.event.payload.summary }
              : {}),
            ...(deps.event.type === "task.progress" && deps.event.payload.lastToolName
              ? { lastToolName: deps.event.payload.lastToolName }
              : {}),
            ...(deps.event.type === "task.completed" && deps.event.payload.summary
              ? { progressSummary: deps.event.payload.summary }
              : {}),
            ...(deps.event.type === "task.completed" && deps.event.payload.status !== "completed"
              ? { terminalReason: deps.event.payload.status }
              : {}),
            ...((deps.event.type === "task.progress" || deps.event.type === "task.completed") &&
            deps.event.payload.usage !== undefined
              ? { usage: deps.event.payload.usage }
              : {}),
            ...(deps.event.turnId
              ? { turnId: toTurnId(deps.event.turnId) }
              : previous?.turnId
                ? { turnId: previous.turnId }
                : {}),
            ...(previous?.order !== undefined ? { order: previous.order } : {}),
            ...(previous?.membership ? { membership: previous.membership } : {}),
            source: "lifecycle",
            freshness: {
              sessionEpoch: `runtime:${deps.event.provider}`,
              sourcePriority: 4,
              providerMessageId: deps.event.eventId,
              observedOrdinal: deps.ordinal ?? 0,
            },
            createdAt: previous?.createdAt ?? deps.event.createdAt,
            updatedAt: deps.event.createdAt,
          };
    const mergedTask = previous ? mergeTaskPatch(previous, task) : task;
    yield* input.orchestrationEngine.dispatch({
      type: "thread.task.upsert",
      commandId: input.providerCommandId(deps.event, "thread-task-upsert"),
      threadId: deps.threadId,
      task: mergedTask,
      createdAt: deps.event.createdAt,
    });
  });

  return {
    appendActivities,
    handleThreadMetadataUpdated,
    handleTurnDiffUpdated,
    upsertTask,
  };
}
