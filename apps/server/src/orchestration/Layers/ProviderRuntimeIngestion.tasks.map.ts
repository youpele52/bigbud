/**
 * Maps provider task runtime events onto durable `OrchestrationTask` snapshots.
 *
 * Optional fields fall back to the previous snapshot so partial provider updates never erase
 * known data. `endedAt` is stamped on the first terminal status, and a task that leaves a
 * terminal status (a newer provider run) drops its stale end time and result.
 *
 * @module ProviderRuntimeIngestion.tasks.map
 */
import type {
  OrchestrationTask,
  OrchestrationTaskKind,
  ProviderRuntimeTaskCompletedEvent,
  ProviderRuntimeTaskProgressEvent,
  ProviderRuntimeTaskStartedEvent,
  ProviderRuntimeTaskUpdatedEvent,
  RuntimeTaskId,
} from "@bigbud/contracts";
import { mergeTaskSnapshot } from "@bigbud/shared/providerSubagents";

import { toTurnId } from "./ProviderRuntimeIngestion.helpers.ts";

export type TaskUpsertRuntimeEvent =
  | ProviderRuntimeTaskStartedEvent
  | ProviderRuntimeTaskProgressEvent
  | ProviderRuntimeTaskCompletedEvent
  | ProviderRuntimeTaskUpdatedEvent;

/**
 * Claude reports each native task twice: as `task.updated` snapshots and as lifecycle
 * `task.started`/`task.progress`/`task.completed` events. Once another source owns the task,
 * the lifecycle copy would only add a second persisted upsert, so it is skipped. Activities
 * still derive from the lifecycle event, and every other provider keeps its behavior.
 */
export function isDuplicateClaudeLifecycleUpsert(
  event: Pick<TaskUpsertRuntimeEvent, "type" | "provider">,
  current: OrchestrationTask | undefined,
): boolean {
  return (
    event.provider === "claudeAgent" &&
    event.type !== "task.updated" &&
    current !== undefined &&
    current.source !== "lifecycle"
  );
}

export const isTerminalTaskStatus = (status: OrchestrationTask["status"]) =>
  status === "completed" || status === "failed" || status === "stopped";

const pick = <K extends keyof OrchestrationTask>(
  key: K,
  incoming: OrchestrationTask[K] | undefined,
  previous: OrchestrationTask | undefined,
): Partial<Pick<OrchestrationTask, K>> =>
  incoming !== undefined
    ? ({ [key]: incoming } as Partial<Pick<OrchestrationTask, K>>)
    : previous?.[key] !== undefined
      ? ({ [key]: previous[key] } as Partial<Pick<OrchestrationTask, K>>)
      : {};

function mapTaskUpdated(input: {
  readonly event: ProviderRuntimeTaskUpdatedEvent;
  readonly taskId: RuntimeTaskId;
  readonly taskKind: OrchestrationTaskKind;
  readonly nativeId: string;
  readonly previous: OrchestrationTask | undefined;
}): OrchestrationTask {
  const { event, previous } = input;
  const payload = event.payload;
  return {
    id: input.taskId,
    kind: input.taskKind,
    ...(input.taskKind === "providerSubagent"
      ? { nativeId: input.nativeId }
      : payload.nativeId
        ? { nativeId: payload.nativeId }
        : {}),
    activityFresh: payload.activityFresh ?? previous?.activityFresh ?? false,
    status: payload.status,
    subject: payload.subject,
    ...pick("description", payload.description, previous),
    ...(payload.activeLabel ? { activeLabel: payload.activeLabel } : {}),
    ...pick("sourceToolUseId", payload.sourceToolUseId, previous),
    ...(payload.requestId ? { requestId: payload.requestId } : {}),
    ...(payload.agentId ? { agentId: payload.agentId } : {}),
    ...(payload.parentAgentId ? { parentAgentId: payload.parentAgentId } : {}),
    ...(payload.parentToolUseId ? { parentToolUseId: payload.parentToolUseId } : {}),
    ...(payload.parentTaskId ? { parentTaskId: payload.parentTaskId } : {}),
    ...(payload.subagentType ? { subagentType: payload.subagentType } : {}),
    ...(payload.background !== undefined ? { background: payload.background } : {}),
    ...(payload.blockedBy ? { blockedBy: payload.blockedBy } : {}),
    ...(payload.progressSummary ? { progressSummary: payload.progressSummary } : {}),
    ...(payload.lastToolName ? { lastToolName: payload.lastToolName } : {}),
    ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
    ...(payload.terminalReason ? { terminalReason: payload.terminalReason } : {}),
    ...pick("model", payload.model, previous),
    ...pick("effort", payload.effort, previous),
    ...pick("prompt", payload.prompt, previous),
    ...pick("depth", payload.depth, previous),
    // The snapshot merge keeps stored end data, and drops it when a newer run reopens the task.
    ...(payload.endedAt ? { endedAt: payload.endedAt } : {}),
    ...(payload.resultSummary ? { resultSummary: payload.resultSummary } : {}),
    ...pick("metrics", payload.metrics, previous),
    ...pick("recentSteps", payload.recentSteps, previous),
    ...pick("turnId", payload.turnId, previous),
    ...pick("order", payload.order, previous),
    ...pick("membership", payload.membership, previous),
    source: payload.source,
    freshness: payload.freshness,
    createdAt: previous?.createdAt ?? payload.createdAt ?? event.createdAt,
    updatedAt: event.createdAt,
  };
}

function mapTaskLifecycle(input: {
  readonly event: Exclude<TaskUpsertRuntimeEvent, ProviderRuntimeTaskUpdatedEvent>;
  readonly taskId: RuntimeTaskId;
  readonly previous: OrchestrationTask | undefined;
  readonly ordinal: number;
}): OrchestrationTask {
  const { event, previous } = input;
  // End data is carried by the snapshot merge, which drops it when the task reopens.
  const { endedAt: _endedAt, resultSummary: _resultSummary, ...carried } = previous ?? {};
  const status =
    event.type === "task.completed"
      ? event.payload.status
      : event.type === "task.progress"
        ? "inProgress"
        : "pending";
  return {
    ...carried,
    id: input.taskId,
    kind: previous?.kind ?? "task",
    activityFresh: previous?.activityFresh ?? false,
    status,
    subject:
      event.type === "task.progress"
        ? event.payload.description
        : event.type === "task.started"
          ? (event.payload.description ?? previous?.subject ?? "Task")
          : (previous?.subject ?? "Task"),
    ...(event.type === "task.progress" && event.payload.summary
      ? { progressSummary: event.payload.summary }
      : {}),
    ...(event.type === "task.progress" && event.payload.lastToolName
      ? { lastToolName: event.payload.lastToolName }
      : {}),
    ...(event.type === "task.completed" && event.payload.summary
      ? { progressSummary: event.payload.summary }
      : {}),
    ...(event.type === "task.completed" && event.payload.status !== "completed"
      ? { terminalReason: event.payload.status }
      : {}),
    ...((event.type === "task.progress" || event.type === "task.completed") &&
    event.payload.usage !== undefined
      ? { usage: event.payload.usage }
      : {}),
    ...(event.turnId
      ? { turnId: toTurnId(event.turnId) }
      : previous?.turnId
        ? { turnId: previous.turnId }
        : {}),
    source: "lifecycle",
    freshness: {
      sessionEpoch: `runtime:${event.provider}`,
      sourcePriority: 4,
      providerMessageId: event.eventId,
      observedOrdinal: input.ordinal,
    },
    createdAt: previous?.createdAt ?? event.createdAt,
    updatedAt: event.createdAt,
  };
}

/** Builds the merged snapshot to persist for one task runtime event. */
export function buildRuntimeTaskSnapshot(input: {
  readonly event: TaskUpsertRuntimeEvent;
  readonly taskId: RuntimeTaskId;
  readonly taskKind: OrchestrationTaskKind;
  readonly nativeId: string;
  readonly previous: OrchestrationTask | undefined;
  readonly ordinal: number;
}): OrchestrationTask {
  const { previous } = input;
  const task =
    input.event.type === "task.updated"
      ? mapTaskUpdated({ ...input, event: input.event })
      : mapTaskLifecycle({ ...input, event: input.event });
  const merged = previous ? mergeTaskSnapshot(previous, task) : task;
  return !isTerminalTaskStatus(merged.status) || merged.endedAt
    ? merged
    : { ...merged, endedAt: input.event.createdAt };
}
