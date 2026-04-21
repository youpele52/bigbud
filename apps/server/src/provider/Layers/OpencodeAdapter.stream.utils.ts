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

import type { MutableTurnSnapshot } from "./OpencodeAdapter.types.ts";
import { PROVIDER } from "./OpencodeAdapter.types.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";

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
 * Map OpenCode permission metadata to our request type taxonomy.
 */
export function requestTypeFromPermission(permission: {
  metadata?: Record<string, unknown>;
}):
  | "command_execution_approval"
  | "file_change_approval"
  | "file_read_approval"
  | "dynamic_tool_call"
  | "unknown" {
  const meta = permission.metadata;
  if (!meta) return "unknown";
  const tool = typeof meta.tool === "string" ? meta.tool : undefined;
  if (tool?.includes("bash") || tool?.includes("shell") || tool?.includes("exec")) {
    return "command_execution_approval";
  }
  if (tool?.includes("write") || tool?.includes("edit") || tool?.includes("patch")) {
    return "file_change_approval";
  }
  if (tool?.includes("read") || tool?.includes("glob") || tool?.includes("grep")) {
    return "file_read_approval";
  }
  return "dynamic_tool_call";
}

export function requestDetailFromPermission(permission: {
  metadata?: Record<string, unknown>;
}): string | undefined {
  const meta = permission.metadata;
  if (!meta) return undefined;
  return (
    normalizeString(meta.description) ??
    normalizeString(meta.command) ??
    normalizeString(meta.tool) ??
    normalizeString(meta.path)
  );
}

export function withOpencodeDirectory<T extends object>(
  cwd: string | undefined,
  input: T,
): T | (T & { query: { directory: string } }) {
  return cwd ? { ...input, query: { directory: cwd } } : input;
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
