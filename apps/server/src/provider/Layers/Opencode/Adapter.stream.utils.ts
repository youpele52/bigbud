/**
 * OpencodeAdapter stream utilities — pure helper functions for event mapping.
 *
 * @module OpencodeAdapter.stream.utils
 */
import {
  EventId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";

import type { MutableTurnSnapshot } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../../Services/ProviderAdapter.ts";

// ── Utility helpers ───────────────────────────────────────────────────

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

export function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function toRuntimeItemId(value: string | undefined): RuntimeItemId | undefined {
  return value ? RuntimeItemId.makeUnsafe(value) : undefined;
}

export function toRuntimeRequestId(value: string | undefined): RuntimeRequestId | undefined {
  return value ? RuntimeRequestId.makeUnsafe(value) : undefined;
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value ? ProviderItemId.makeUnsafe(value) : undefined;
}

/**
 * Map OpenCode v2 PermissionRequest to our request type taxonomy.
 * v2 uses a `permission` string field (the tool name) and `patterns` array.
 */
export function requestTypeFromPermission(permission: {
  permission: string;
  patterns: Array<string>;
}):
  | "command_execution_approval"
  | "file_change_approval"
  | "file_read_approval"
  | "browser_approval"
  | "dynamic_tool_call"
  | "unknown" {
  const tool = permission.permission;
  if (tool.includes("bash") || tool.includes("shell") || tool.includes("exec")) {
    return "command_execution_approval";
  }
  if (tool.includes("write") || tool.includes("edit") || tool.includes("patch")) {
    return "file_change_approval";
  }
  if (tool.includes("read") || tool.includes("glob") || tool.includes("grep")) {
    return "file_read_approval";
  }
  if (tool.includes("browser") || tool.includes("mcp_browser") || tool.includes("web_search")) {
    return "browser_approval";
  }
  return "dynamic_tool_call";
}

export function requestDetailFromPermission(permission: {
  permission: string;
  patterns: Array<string>;
}): string | undefined {
  return normalizeString(permission.patterns[0]) ?? normalizeString(permission.permission);
}

export function buildThreadSnapshot(
  threadId: ThreadId,
  turns: ReadonlyArray<MutableTurnSnapshot>,
): ProviderThreadSnapshot {
  return {
    threadId,
    turns: turns.map<ProviderThreadTurnSnapshot>((turn) => ({
      id: turn.id,
      items: [...turn.items],
    })),
  };
}

export function eventBase(input: {
  eventId: EventId;
  createdAt: string;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: ProviderRuntimeEvent["raw"];
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const providerTurnId = input.turnId;
  const providerItemId = toProviderItemId(input.itemId);
  const providerRequestId = normalizeString(input.requestId);

  return {
    eventId: input.eventId,
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: toRuntimeRequestId(input.requestId) } : {}),
    ...(providerTurnId || providerItemId || providerRequestId
      ? {
          providerRefs: {
            ...(providerTurnId ? { providerTurnId } : {}),
            ...(providerItemId ? { providerItemId } : {}),
            ...(providerRequestId ? { providerRequestId } : {}),
          },
        }
      : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  };
}
