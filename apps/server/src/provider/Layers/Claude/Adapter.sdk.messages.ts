import type {
  SDKBackgroundTasksChangedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKResultMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeSdkIdentity {
  readonly type: string;
  readonly subtype?: string;
  readonly uuid: string;
  readonly sessionId: string;
}

export interface ClaudeSdkTaskMessage extends ClaudeSdkIdentity {
  readonly taskId: string;
  readonly toolUseId?: string;
  readonly description: string;
  readonly summary?: string;
  readonly lastToolName?: string;
  readonly subagentType?: string;
  readonly usage?: {
    readonly totalTokens: number;
    readonly toolUses: number;
    readonly durationMs: number;
  };
}

export interface ClaudeSdkTaskNotification extends ClaudeSdkIdentity {
  readonly taskId: string;
  readonly toolUseId?: string;
  readonly status: "completed" | "failed" | "stopped";
  readonly summary: string;
  readonly usage?: {
    readonly totalTokens: number;
    readonly toolUses: number;
    readonly durationMs: number;
  };
}

export interface ClaudeSdkTaskUpdate extends ClaudeSdkIdentity {
  readonly taskId: string;
  readonly patch: Record<string, unknown>;
}

export interface ClaudeSdkBackgroundTasks extends ClaudeSdkIdentity {
  readonly tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly taskType: string;
    readonly description: string;
  }>;
}

export interface ClaudeSdkHookMessage extends ClaudeSdkIdentity {
  readonly hookId: string;
  readonly hookName: string;
  readonly hookEvent: string;
  readonly output?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly outcome?: "success" | "error" | "cancelled";
}

export interface ClaudeSdkRetry extends ClaudeSdkIdentity {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly errorStatus: number | null;
  readonly error: string;
}

export interface ClaudeSdkRefusal extends ClaudeSdkIdentity {
  readonly subtype: "model_refusal_fallback" | "model_refusal_no_fallback";
  readonly originalModel: string;
  readonly requestId: string | null;
  readonly category?: string | null;
  readonly fallbackModel?: string;
}

export interface ClaudeSdkCommandUpdate extends ClaudeSdkIdentity {
  readonly commands: ReadonlyArray<{ readonly name: string }>;
}

export interface ClaudeSdkMcpInitialization extends ClaudeSdkIdentity {
  readonly servers: ReadonlyArray<{ readonly name: string; readonly status: string }>;
}

export interface ClaudeSdkElicitationComplete extends ClaudeSdkIdentity {
  readonly serverName: string;
  readonly elicitationId: string;
}

export interface ClaudeSdkPermissionCallback {
  readonly requestId: string;
  readonly toolUseId: string;
  readonly agentId?: string;
  readonly hasSuggestions: boolean;
}

export interface ClaudeSdkUserToolResult {
  readonly uuid?: string;
  readonly sessionId?: string;
  readonly hasStructuredResult: boolean;
}

type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function identity(
  value: unknown,
  type: string,
  subtype?: string,
): ClaudeSdkIdentity | undefined {
  const record = asRecord(value);
  const uuid = string(record?.uuid);
  const sessionId = string(record?.session_id);
  if (
    !record ||
    record.type !== type ||
    (subtype !== undefined && record.subtype !== subtype) ||
    !uuid ||
    !sessionId
  ) {
    return undefined;
  }
  return { type, ...(subtype ? { subtype } : {}), uuid, sessionId };
}

export function usage(value: unknown): ClaudeSdkTaskMessage["usage"] | undefined {
  const record = asRecord(value);
  const totalTokens = finiteNumber(record?.total_tokens);
  const toolUses = finiteNumber(record?.tool_uses);
  const durationMs = finiteNumber(record?.duration_ms);
  return totalTokens === undefined || toolUses === undefined || durationMs === undefined
    ? undefined
    : { totalTokens, toolUses, durationMs };
}

export function taskPatch(value: unknown): Record<string, unknown> | undefined {
  const patch = asRecord(value);
  const status = patch?.status;
  if (
    !patch ||
    (status !== undefined &&
      !["pending", "running", "completed", "failed", "killed", "paused"].includes(
        String(status),
      )) ||
    (patch.description !== undefined && !string(patch.description)) ||
    (patch.error !== undefined && !string(patch.error)) ||
    (patch.end_time !== undefined && finiteNumber(patch.end_time) === undefined) ||
    (patch.total_paused_ms !== undefined && finiteNumber(patch.total_paused_ms) === undefined) ||
    (patch.is_backgrounded !== undefined && typeof patch.is_backgrounded !== "boolean")
  ) {
    return undefined;
  }
  return { ...patch };
}

export {
  decodeClaudeBackgroundTasksChangedMessage,
  decodeClaudeHookMessage,
  decodeClaudeTaskNotificationMessage,
  decodeClaudeTaskProgressMessage,
  decodeClaudeTaskStartedMessage,
  decodeClaudeTaskUpdatedMessage,
} from "./Adapter.sdk.messages.tasks.ts";

export { decodeClaudeResultMessage, type ClaudeSdkResult } from "./Adapter.sdk.messages.result.ts";

export function decodeClaudeApiRetryMessage(value: unknown): ClaudeSdkRetry | undefined {
  const base = identity(value, "system", "api_retry");
  const record = asRecord(value);
  const attempt = finiteNumber(record?.attempt);
  const maxRetries = finiteNumber(record?.max_retries);
  const retryDelayMs = finiteNumber(record?.retry_delay_ms);
  const errorStatus = record?.error_status;
  const error = string(record?.error);
  return base &&
    attempt !== undefined &&
    maxRetries !== undefined &&
    retryDelayMs !== undefined &&
    (errorStatus === null || finiteNumber(errorStatus) !== undefined) &&
    error
    ? {
        ...base,
        attempt,
        maxRetries,
        retryDelayMs,
        errorStatus: errorStatus === null ? null : finiteNumber(errorStatus)!,
        error,
      }
    : undefined;
}

export function decodeClaudeRefusalMessage(value: unknown): ClaudeSdkRefusal | undefined {
  const subtype = asRecord(value)?.subtype;
  if (subtype !== "model_refusal_fallback" && subtype !== "model_refusal_no_fallback")
    return undefined;
  const base = identity(value, "system", subtype);
  const record = asRecord(value);
  const originalModel = string(record?.original_model);
  const requestId = record?.request_id;
  if (!base || !originalModel || (requestId !== null && typeof requestId !== "string"))
    return undefined;
  const category = record?.api_refusal_category;
  const fallbackModel = string(record?.fallback_model);
  return {
    ...base,
    subtype,
    originalModel,
    requestId,
    ...(category === null || typeof category === "string" ? { category } : {}),
    ...(fallbackModel ? { fallbackModel } : {}),
  };
}

export function decodeClaudeCommandsChangedMessage(
  value: unknown,
): ClaudeSdkCommandUpdate | undefined {
  const base = identity(value, "system", "commands_changed");
  const commands = asRecord(value)?.commands;
  if (!base || !Array.isArray(commands)) return undefined;
  const normalized = commands
    .map((command) => string(asRecord(command)?.name))
    .filter((name): name is string => name !== undefined);
  return normalized.length === commands.length
    ? { ...base, commands: normalized.map((name) => ({ name })) }
    : undefined;
}

export function decodeClaudeMcpInitialization(
  value: unknown,
): ClaudeSdkMcpInitialization | undefined {
  const base = identity(value, "system", "init");
  const servers = asRecord(value)?.mcp_servers;
  if (!base || !Array.isArray(servers)) return undefined;
  const normalized = servers.map((server) => {
    const record = asRecord(server);
    const name = string(record?.name);
    const status = string(record?.status);
    return name && status ? { name, status } : undefined;
  });
  return normalized.every((server) => server !== undefined)
    ? { ...base, servers: normalized }
    : undefined;
}

export function decodeClaudeElicitationCompleteMessage(
  value: unknown,
): ClaudeSdkElicitationComplete | undefined {
  const base = identity(value, "system", "elicitation_complete");
  const record = asRecord(value);
  const serverName = string(record?.mcp_server_name);
  const elicitationId = string(record?.elicitation_id);
  return base && serverName && elicitationId ? { ...base, serverName, elicitationId } : undefined;
}

export function decodeClaudePermissionCallback(value: {
  readonly requestId: string;
  readonly toolUseID?: string;
  readonly agentID?: string;
  readonly suggestions?: ReadonlyArray<unknown>;
}): ClaudeSdkPermissionCallback | undefined {
  return typeof value.requestId === "string" && typeof value.toolUseID === "string"
    ? {
        requestId: value.requestId,
        toolUseId: value.toolUseID,
        ...(value.agentID ? { agentId: value.agentID } : {}),
        hasSuggestions: (value.suggestions?.length ?? 0) > 0,
      }
    : undefined;
}

export function decodeClaudeUserToolResult(value: SDKUserMessage): ClaudeSdkUserToolResult {
  return {
    ...(typeof value.uuid === "string" ? { uuid: value.uuid } : {}),
    ...(typeof value.session_id === "string" ? { sessionId: value.session_id } : {}),
    hasStructuredResult: value.tool_use_result !== undefined,
  };
}

export type ClaudeSdkTaskSource =
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskNotificationMessage
  | SDKTaskUpdatedMessage
  | SDKBackgroundTasksChangedMessage;
export type ClaudeSdkHookSource =
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage;
export type ClaudeSdkResultSource = SDKResultMessage;
