import {
  asRecord,
  finiteNumber,
  identity,
  string,
  taskPatch,
  usage,
  type ClaudeSdkBackgroundTasks,
  type ClaudeSdkHookMessage,
  type ClaudeSdkTaskMessage,
  type ClaudeSdkTaskNotification,
  type ClaudeSdkTaskUpdate,
} from "./Adapter.sdk.messages.ts";

export function decodeClaudeTaskStartedMessage(value: unknown): ClaudeSdkTaskMessage | undefined {
  const base = identity(value, "system", "task_started");
  const record = asRecord(value);
  const taskId = string(record?.task_id);
  const description = string(record?.description);
  if (!base || !taskId || !description) return undefined;
  const toolUseId = string(record?.tool_use_id);
  return { ...base, taskId, description, ...(toolUseId ? { toolUseId } : {}) };
}

export function decodeClaudeTaskProgressMessage(value: unknown): ClaudeSdkTaskMessage | undefined {
  const base = identity(value, "system", "task_progress");
  const record = asRecord(value);
  const taskId = string(record?.task_id);
  const description = string(record?.description);
  const taskUsage = usage(record?.usage);
  if (!base || !taskId || !description || !taskUsage) return undefined;
  const toolUseId = string(record?.tool_use_id);
  const summary = string(record?.summary);
  const lastToolName = string(record?.last_tool_name);
  const subagentType = string(record?.subagent_type);
  return {
    ...base,
    taskId,
    description,
    usage: taskUsage,
    ...(toolUseId ? { toolUseId } : {}),
    ...(summary ? { summary } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(subagentType ? { subagentType } : {}),
  };
}

export function decodeClaudeTaskNotificationMessage(
  value: unknown,
): ClaudeSdkTaskNotification | undefined {
  const base = identity(value, "system", "task_notification");
  const record = asRecord(value);
  const taskId = string(record?.task_id);
  const summary = string(record?.summary);
  const status = record?.status;
  if (
    !base ||
    !taskId ||
    !summary ||
    (status !== "completed" && status !== "failed" && status !== "stopped")
  )
    return undefined;
  const toolUseId = string(record?.tool_use_id);
  const taskUsage = usage(record?.usage);
  return {
    ...base,
    taskId,
    summary,
    status,
    ...(taskUsage ? { usage: taskUsage } : {}),
    ...(toolUseId ? { toolUseId } : {}),
  };
}

export function decodeClaudeTaskUpdatedMessage(value: unknown): ClaudeSdkTaskUpdate | undefined {
  const base = identity(value, "system", "task_updated");
  const record = asRecord(value);
  const taskId = string(record?.task_id);
  const patch = taskPatch(record?.patch);
  return base && taskId && patch ? { ...base, taskId, patch } : undefined;
}

export function decodeClaudeBackgroundTasksChangedMessage(
  value: unknown,
): ClaudeSdkBackgroundTasks | undefined {
  const base = identity(value, "system", "background_tasks_changed");
  const tasks = asRecord(value)?.tasks;
  if (!base || !Array.isArray(tasks)) return undefined;
  const normalized = tasks.map((task) => {
    const record = asRecord(task);
    const taskId = string(record?.task_id);
    const taskType = string(record?.task_type);
    const description = string(record?.description);
    return taskId && taskType && description ? { taskId, taskType, description } : undefined;
  });
  return normalized.every((task) => task !== undefined)
    ? { ...base, tasks: normalized }
    : undefined;
}

export function decodeClaudeHookMessage(value: unknown): ClaudeSdkHookMessage | undefined {
  const subtype = asRecord(value)?.subtype;
  if (subtype !== "hook_started" && subtype !== "hook_progress" && subtype !== "hook_response")
    return undefined;
  const base = identity(value, "system", subtype);
  const record = asRecord(value);
  const hookId = string(record?.hook_id);
  const hookName = string(record?.hook_name);
  const hookEvent = string(record?.hook_event);
  if (!base || !hookId || !hookName || !hookEvent) return undefined;
  const output = string(record?.output);
  const stdout = string(record?.stdout);
  const stderr = string(record?.stderr);
  const exitCode = finiteNumber(record?.exit_code);
  const outcome = record?.outcome;
  if (
    (subtype !== "hook_started" &&
      (output === undefined || stdout === undefined || stderr === undefined)) ||
    (outcome !== undefined &&
      outcome !== "success" &&
      outcome !== "error" &&
      outcome !== "cancelled")
  )
    return undefined;
  return {
    ...base,
    hookId,
    hookName,
    hookEvent,
    ...(output !== undefined ? { output } : {}),
    ...(stdout !== undefined ? { stdout } : {}),
    ...(stderr !== undefined ? { stderr } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(outcome ? { outcome } : {}),
  };
}
