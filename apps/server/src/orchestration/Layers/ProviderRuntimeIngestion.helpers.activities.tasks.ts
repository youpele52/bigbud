import {
  EventId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";

import type { RuntimeEventActivityHelpers } from "./ProviderRuntimeIngestion.helpers.activities.types.ts";

export interface RuntimeActivitySequence {
  readonly sequence?: number;
}

function taskActivityId(taskId: string, kind: string) {
  return EventId.makeUnsafe(`task:${taskId}:${kind}`);
}

/** Maps provider-neutral task lifecycle events to work-log activities. */
export function taskRuntimeEventToActivities(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "task.started" | "task.progress" | "task.completed" | "task.updated" }
  >,
  helpers: RuntimeEventActivityHelpers,
  sequence: RuntimeActivitySequence,
): ReadonlyArray<OrchestrationThreadActivity> {
  switch (event.type) {
    case "task.started":
      return [
        {
          id: taskActivityId(String(event.payload.taskId), "started"),
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: helpers.truncateDetail(event.payload.description) }
              : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "task.progress":
      return [
        {
          id: taskActivityId(String(event.payload.taskId), "progress"),
          createdAt: event.createdAt,
          tone: "thinking",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail: helpers.truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary
              ? { summary: helpers.truncateDetail(event.payload.summary) }
              : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "task.completed":
      return [
        {
          id: taskActivityId(String(event.payload.taskId), "completed"),
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary
              ? { detail: helpers.truncateDetail(event.payload.summary) }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "task.updated":
      return [
        {
          id: taskActivityId(String(event.payload.taskId), "updated"),
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary: event.payload.subject,
          payload: {
            task: {
              ...event.payload,
              createdAt: event.payload.createdAt ?? event.createdAt,
              updatedAt: event.createdAt,
            },
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
  }
}
