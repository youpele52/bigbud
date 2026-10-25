import { RuntimeTaskId, TurnId, type TurnPlanUpdatedPayload } from "@bigbud/contracts";
import { compareTaskOrder } from "@bigbud/shared/providerRuntime";

import {
  isClaudeProviderSubagent,
  resolveClaudeSubagentModel,
  type ClaudeTaskClassificationOptions,
} from "./Adapter.tasks.classify.ts";
import { reduceClaudeTaskState } from "./Adapter.tasks.reducer.ts";
import {
  makeClaudeTaskState,
  type ClaudeTask,
  type ClaudeTaskReduction,
  type ClaudeTaskState,
} from "./Adapter.tasks.types.ts";

export type { ClaudeTask, ClaudeTaskReduction, ClaudeTaskState };
export { makeClaudeTaskState, reduceClaudeTaskState };

export function isClaudeTaskTool(toolName: string): boolean {
  return [
    "TodoWrite",
    "TaskCreate",
    "TaskUpdate",
    "TaskGet",
    "TaskList",
    "task_notification",
    "task_updated",
    "background_tasks_changed",
  ].includes(toolName);
}

export function reduceClaudeTasks(input: {
  readonly state: ClaudeTaskState;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly value: Record<string, unknown>;
  readonly updatedAt: string;
  readonly authoritativeSnapshot?: boolean;
}): boolean {
  return reduceClaudeTaskState(input).changed;
}

/**
 * Plan checklist steps. Provider subagents are shown in the Subagents card, never as plan
 * steps (D8); an unsupported harness keeps them as ordinary tasks.
 */
export function claudeTaskPlanPayload(
  state: ClaudeTaskState,
  includeEmpty = false,
  providerSubagentsSupported = true,
): TurnPlanUpdatedPayload | undefined {
  const modern = Array.from(state.tasks.values()).filter(
    (task) =>
      !task.legacyMember &&
      (task.taskListMember || task.backgroundMember || task.observedMember) &&
      !isClaudeProviderSubagent(task, providerSubagentsSupported),
  );
  const visible =
    modern.length > 0
      ? modern
      : Array.from(state.tasks.values()).filter((task) => task.legacyMember);
  if (visible.length === 0 && !includeEmpty) return undefined;
  return {
    plan: visible.toSorted(compareTaskOrder).map((task) => ({
      step: task.subject,
      status:
        task.status === "stopped"
          ? "pending"
          : task.status === "pending" || task.status === "inProgress"
            ? task.status
            : "completed",
    })),
  };
}

function runtimeStatus(task: ClaudeTask) {
  if (["failed", "error"].includes(task.nativeStatus ?? "")) return "failed" as const;
  if (["cancelled", "killed", "stopped", "interrupted"].includes(task.nativeStatus ?? "")) {
    return "stopped" as const;
  }
  return task.status;
}

function runtimeSource(task: ClaudeTask) {
  if (task.taskListMember) return "taskList" as const;
  if (task.backgroundMember) return "background" as const;
  if (task.observedMember) return "observed" as const;
  return "lifecycle" as const;
}

function subagentPayload(task: ClaudeTask, options: ClaudeTaskClassificationOptions) {
  const model = resolveClaudeSubagentModel(task, options.agentModels);
  return {
    ...(model ? { model } : {}),
    ...(task.effort ? { effort: task.effort } : {}),
    ...(task.prompt ? { prompt: task.prompt } : {}),
    ...(task.depth !== undefined ? { depth: task.depth } : {}),
    ...(task.endedAt ? { endedAt: task.endedAt } : {}),
    ...(task.resultSummary ? { resultSummary: task.resultSummary } : {}),
    ...(task.metrics ? { metrics: task.metrics } : {}),
    ...(task.recentSteps && task.recentSteps.length > 0 ? { recentSteps: task.recentSteps } : {}),
  };
}

export function claudeTaskRuntimeUpdates(
  state: ClaudeTaskState,
  taskIds?: ReadonlyArray<string>,
  options: ClaudeTaskClassificationOptions = { providerSubagentsSupported: true },
) {
  const selected = taskIds ? new Set(taskIds) : undefined;
  return Array.from(state.tasks.values())
    .filter((task) => !task.legacyMember && (!selected || selected.has(task.id)))
    .toSorted(compareTaskOrder)
    .map((task) => ({
      taskId: RuntimeTaskId.makeUnsafe(task.id),
      kind: isClaudeProviderSubagent(task, options.providerSubagentsSupported)
        ? ("providerSubagent" as const)
        : ("task" as const),
      nativeId: task.id,
      activityFresh: true,
      status: runtimeStatus(task),
      subject: task.subject,
      ...(task.description ? { description: task.description } : {}),
      ...(task.activeLabel ? { activeLabel: task.activeLabel } : {}),
      sourceToolUseId: task.sourceToolUseId,
      ...(task.requestId ? { requestId: task.requestId } : {}),
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(task.parentAgentId ? { parentAgentId: task.parentAgentId } : {}),
      ...(task.parentToolUseId ? { parentToolUseId: task.parentToolUseId } : {}),
      ...(task.parentTaskId ? { parentTaskId: RuntimeTaskId.makeUnsafe(task.parentTaskId) } : {}),
      ...(task.subagentType ? { subagentType: task.subagentType } : {}),
      ...(task.backgroundMember || task.background ? { background: true } : {}),
      ...(task.blockedBy
        ? { blockedBy: task.blockedBy.map((id) => RuntimeTaskId.makeUnsafe(id)) }
        : {}),
      ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
      ...(task.lastToolName ? { lastToolName: task.lastToolName } : {}),
      ...(task.usage !== undefined ? { usage: task.usage } : {}),
      ...(task.terminalReason ? { terminalReason: task.terminalReason } : {}),
      ...subagentPayload(task, options),
      ...(task.turnId ? { turnId: TurnId.makeUnsafe(task.turnId) } : {}),
      order: task.order,
      membership: {
        taskList: task.taskListMember,
        background: task.backgroundMember,
        observed: task.observedMember,
        legacy: task.legacyMember,
      },
      source: runtimeSource(task),
      freshness: {
        sessionEpoch: task.freshness.sessionEpoch ?? "initial",
        sourcePriority: task.freshness.sourcePriority,
        ...(task.freshness.snapshotGeneration !== undefined
          ? { snapshotGeneration: task.freshness.snapshotGeneration }
          : {}),
        ...(task.freshness.providerRevision !== undefined
          ? { providerRevision: task.freshness.providerRevision }
          : {}),
        ...(task.freshness.providerMessageId
          ? { providerMessageId: task.freshness.providerMessageId }
          : {}),
        ...(task.freshness.providerTimestamp
          ? { providerTimestamp: task.freshness.providerTimestamp }
          : {}),
        observedOrdinal: task.freshness.observedOrdinal,
      },
      createdAt: task.updatedAt,
    }));
}
