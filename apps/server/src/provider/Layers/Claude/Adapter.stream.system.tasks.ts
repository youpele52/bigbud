/**
 * Native Claude task system messages: `task_started`, `task_progress`, `task_notification`,
 * `task_updated` and `background_tasks_changed`.
 *
 * Task usage describes the task's own work, so it maps to task metrics and never to the
 * thread's context meter.
 *
 * @module ClaudeAdapter.stream.system.tasks
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type EventId, RuntimeTaskId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import {
  decodeClaudeBackgroundTasksChangedMessage,
  decodeClaudeTaskNotificationMessage,
  decodeClaudeTaskProgressMessage,
  decodeClaudeTaskStartedMessage,
  decodeClaudeTaskUpdatedMessage,
  type ClaudeSdkBackgroundTasks,
  type ClaudeSdkTaskMessage,
} from "./Adapter.sdk.messages.ts";
import { takeAgentToolInput } from "./Adapter.stream.subagents.ts";
import { updateClaudeTaskPlan } from "./Adapter.stream.tasks.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";

export type TaskSystemEventBase = Omit<
  Extract<ProviderRuntimeEvent, { type: "task.started" }>,
  "type" | "payload"
>;

const TASK_SUBTYPES = new Set([
  "task_started",
  "task_progress",
  "task_notification",
  "task_updated",
  "background_tasks_changed",
]);

function metrics(usage: ClaudeSdkTaskMessage["usage"]) {
  return usage
    ? { totalTokens: usage.totalTokens, toolUses: usage.toolUses, durationMs: usage.durationMs }
    : undefined;
}

/** Reducer record for one `background_tasks_changed` entry, with SDK wire keys. */
function backgroundTaskRecord(
  task: ClaudeSdkBackgroundTasks["tasks"][number],
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    task_id: task.taskId,
    task_type: task.taskType,
    description: task.description,
  };
  if (task.subagentType) record.subagent_type = task.subagentType;
  if (task.parentTaskId) record.parent_task_id = task.parentTaskId;
  if (task.runId) record.run_id = task.runId;
  if (task.ambient !== undefined) record.ambient = task.ambient;
  return record;
}

export function isClaudeTaskSystemMessage(message: SDKMessage): boolean {
  return message.type === "system" && TASK_SUBTYPES.has(message.subtype);
}

export function makeTaskSystemHandler(deps: {
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
  readonly nowIso: Effect.Effect<string>;
  readonly invalid: (context: ClaudeSessionContext, message: SDKMessage) => Effect.Effect<void>;
}) {
  const { makeEventStamp, offerRuntimeEvent, nowIso, invalid } = deps;
  const update = (
    context: ClaudeSessionContext,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    authoritativeSnapshot?: boolean,
  ) =>
    Effect.flatMap(nowIso, (now) =>
      updateClaudeTaskPlan({
        context,
        toolUseId,
        toolName,
        input,
        ...(authoritativeSnapshot ? { authoritativeSnapshot: true } : {}),
        now,
        makeEventStamp,
        offerRuntimeEvent,
      }),
    );

  // Snapshots go first so the lifecycle copy finds its owner and is skipped by ingestion.
  return Effect.fn("handleClaudeTaskSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
    base: TaskSystemEventBase,
  ) {
    if (message.type !== "system") return;
    switch (message.subtype) {
      case "task_started": {
        const task = decodeClaudeTaskStartedMessage(message);
        if (!task) return yield* invalid(context, message);
        const agentInput = task.toolUseId ? takeAgentToolInput(context, task.toolUseId) : {};
        yield* update(context, task.toolUseId ?? task.taskId, "task_updated", {
          ...agentInput,
          task_id: task.taskId,
          description: task.description,
          status: "running",
          ...(task.taskType ? { task_type: task.taskType } : {}),
          ...(task.subagentType ? { subagent_type: task.subagentType } : {}),
          ...(task.prompt ? { prompt: task.prompt } : {}),
          ...(task.isBackgrounded !== undefined ? { is_backgrounded: task.isBackgrounded } : {}),
          ...(task.spawnDepth !== undefined ? { spawn_depth: task.spawnDepth } : {}),
          ...(task.parentTaskId ? { parent_task_id: task.parentTaskId } : {}),
          ...(task.runId ? { run_id: task.runId } : {}),
          ...(task.ambient !== undefined ? { ambient: task.ambient } : {}),
        });
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(task.taskId),
            description: task.description,
            ...(task.taskType ? { taskType: task.taskType } : {}),
          },
        });
        return;
      }
      case "task_progress": {
        const task = decodeClaudeTaskProgressMessage(message);
        if (!task) return yield* invalid(context, message);
        yield* update(context, task.toolUseId ?? task.taskId, "task_updated", {
          task_id: task.taskId,
          description: task.description,
          ...(task.summary ? { progress_summary: task.summary } : {}),
          ...(task.lastToolName ? { last_tool_name: task.lastToolName } : {}),
          ...(task.subagentType ? { subagent_type: task.subagentType } : {}),
          ...(task.runId ? { run_id: task.runId } : {}),
          ...(task.usage ? { metrics: metrics(task.usage) } : {}),
        });
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(task.taskId),
            description: task.description,
            ...(task.summary ? { summary: task.summary } : {}),
            ...(task.usage ? { usage: task.usage } : {}),
            ...(task.lastToolName ? { lastToolName: task.lastToolName } : {}),
          },
        });
        return;
      }
      case "task_notification": {
        const task = decodeClaudeTaskNotificationMessage(message);
        if (!task) return yield* invalid(context, message);
        const workerRestart = task.reason === "worker_restart";
        yield* update(context, task.toolUseId ?? task.taskId, "task_notification", {
          uuid: task.uuid,
          task_id: task.taskId,
          status: workerRestart ? "stopped" : task.status,
          result_summary: task.summary,
          ...(workerRestart ? { terminal_reason: "worker restarted" } : {}),
          ...(task.runId ? { run_id: task.runId } : {}),
          ...(task.ambient !== undefined ? { ambient: task.ambient } : {}),
          ...(task.usage ? { usage: task.usage, metrics: metrics(task.usage) } : {}),
        });
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(task.taskId),
            status: task.status,
            summary: task.summary,
            ...(task.usage ? { usage: task.usage } : {}),
          },
        });
        return;
      }
      case "task_updated": {
        const task = decodeClaudeTaskUpdatedMessage(message);
        if (!task) return yield* invalid(context, message);
        yield* update(context, task.taskId, "task_updated", {
          task_id: task.taskId,
          patch: task.patch,
        });
        return;
      }
      case "background_tasks_changed": {
        const snapshot = decodeClaudeBackgroundTasksChangedMessage(message);
        if (!snapshot) return yield* invalid(context, message);
        yield* update(
          context,
          snapshot.uuid,
          "background_tasks_changed",
          {
            uuid: snapshot.uuid,
            tasks: snapshot.tasks.map(backgroundTaskRecord),
          },
          true,
        );
        return;
      }
    }
  });
}
