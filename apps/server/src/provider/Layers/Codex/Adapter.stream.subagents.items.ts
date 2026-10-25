/**
 * Pure readers for Codex collab items (`codex app-server generate-ts` 0.162.1).
 *
 * Fields are detected at runtime: older CLIs that lack them produce nothing.
 *
 * @module CodexAdapter.stream.subagents.items
 */
import type { TaskUpdatedPayload } from "@bigbud/contracts";

type Status = TaskUpdatedPayload["status"];

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

export interface CodexCollabCall {
  readonly tool: string;
  readonly senderThreadId?: string;
  readonly receiverThreadIds: ReadonlyArray<string>;
  readonly prompt?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly states: ReadonlyMap<string, { readonly status: string; readonly message?: string }>;
}

export interface CodexSubAgentActivity {
  readonly kind: string;
  readonly agentThreadId: string;
  readonly agentPath?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface CodexChildToolItem {
  readonly id: string;
  readonly toolName: string;
  readonly label?: string;
  readonly finished: boolean;
  readonly failed: boolean;
}

export function readItem(payload: unknown): Record<string, unknown> | undefined {
  return record(record(payload)?.item);
}

export function readConversationId(payload: unknown): string | undefined {
  const params = record(payload);
  return text(params?.threadId) ?? text(params?.conversationId);
}

export function readCollabCall(item: Record<string, unknown>): CodexCollabCall | undefined {
  if (item.type !== "collabAgentToolCall" || typeof item.tool !== "string") return undefined;
  const receivers = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((id): id is string => typeof id === "string" && !!id.trim())
    : [];
  const states = new Map<string, { status: string; message?: string }>();
  for (const [id, value] of Object.entries(record(item.agentsStates) ?? {})) {
    const state = record(value);
    if (typeof state?.status !== "string") continue;
    const message = text(state.message);
    states.set(id, { status: state.status, ...(message ? { message } : {}) });
  }
  const sender = text(item.senderThreadId);
  const prompt = text(item.prompt);
  const model = text(item.model);
  const effort = text(item.reasoningEffort);
  return {
    tool: item.tool,
    ...(sender ? { senderThreadId: sender } : {}),
    receiverThreadIds: receivers.slice(0, 16),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    states,
  };
}

export function readSubAgentActivity(
  item: Record<string, unknown>,
): CodexSubAgentActivity | undefined {
  const agentThreadId = text(item.agentThreadId);
  if (item.type !== "subAgentActivity" || typeof item.kind !== "string" || !agentThreadId)
    return undefined;
  const agentPath = text(item.agentPath);
  const model = text(item.model);
  const effort = text(item.reasoningEffort);
  return {
    kind: item.kind,
    agentThreadId,
    ...(agentPath ? { agentPath } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** `agentsStates[id].status` → task status (notFound is a stopped agent). */
export function collabAgentStatus(
  status: string,
): { readonly status: Status; readonly terminalReason?: string } | undefined {
  switch (status) {
    case "pendingInit":
    case "running":
      return { status: "inProgress" };
    case "completed":
      return { status: "completed" };
    case "errored":
      return { status: "failed" };
    case "interrupted":
    case "shutdown":
      return { status: "stopped" };
    case "notFound":
      return { status: "stopped", terminalReason: "agent not found" };
    default:
      return undefined;
  }
}

export function subAgentActivityStatus(kind: string): Status | undefined {
  switch (kind) {
    case "started":
    case "interacted":
      return "inProgress";
    case "interrupted":
      return "stopped";
    case "completed":
      return "completed";
    default:
      return undefined;
  }
}

/** Tool-like items of a child thread become steps on that child's task. */
export function readChildToolItem(
  item: Record<string, unknown>,
  method: string,
): CodexChildToolItem | undefined {
  const id = text(item.id);
  if (!id) return undefined;
  let toolName: string | undefined;
  let label: string | undefined;
  switch (item.type) {
    case "commandExecution":
      toolName = "command";
      label = text(item.command);
      break;
    case "mcpToolCall":
      toolName = text(item.tool);
      label = text(item.server);
      break;
    case "dynamicToolCall":
      toolName = text(item.tool);
      label = text(item.namespace);
      break;
    case "fileChange":
      toolName = "fileChange";
      break;
    case "webSearch":
      toolName = "webSearch";
      label = text(item.query);
      break;
    default:
      return undefined;
  }
  if (!toolName) return undefined;
  const status = text(item.status);
  const finished = method === "item/completed";
  return {
    id,
    toolName,
    ...(label ? { label } : {}),
    finished,
    failed: finished && (status === "failed" || status === "declined" || item.success === false),
  };
}
