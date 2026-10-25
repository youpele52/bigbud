import { TurnId } from "@bigbud/contracts";

import {
  type CodexSessionContext,
  type CodexThreadSnapshot,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./codexAppServerManager.types";
import { toTurnId, toProviderItemId } from "./codexAppServerManager.utils";

// ---------------------------------------------------------------------------
// Low-level value readers
// ---------------------------------------------------------------------------

export function readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;

  if (!target || typeof target !== "object") {
    return undefined;
  }

  return target as Record<string, unknown>;
}

export function readArray(value: unknown, key?: string): unknown[] | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return Array.isArray(target) ? target : undefined;
}

export function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function readBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

// ---------------------------------------------------------------------------
// JSON-RPC message type guards
// ---------------------------------------------------------------------------

export function isServerRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.method === "string" &&
    (typeof candidate.id === "string" || typeof candidate.id === "number")
  );
}

export function isServerNotification(value: unknown): value is JsonRpcNotification {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.method === "string" && !("id" in candidate);
}

export function isResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
  const hasMethod = typeof candidate.method === "string";
  return hasId && !hasMethod;
}

// ---------------------------------------------------------------------------
// Route field extraction
// ---------------------------------------------------------------------------

export function readRouteFields(params: unknown): {
  turnId?: import("@bigbud/contracts").TurnId;
  itemId?: import("@bigbud/contracts").ProviderItemId;
} {
  const route: {
    turnId?: import("@bigbud/contracts").TurnId;
    itemId?: import("@bigbud/contracts").ProviderItemId;
  } = {};

  const turnId = toTurnId(
    readString(params, "turnId") ?? readString(readObject(params, "turn"), "id"),
  );
  const itemId = toProviderItemId(
    readString(params, "itemId") ?? readString(readObject(params, "item"), "id"),
  );

  if (turnId) {
    route.turnId = turnId;
  }

  if (itemId) {
    route.itemId = itemId;
  }

  return route;
}

export function readProviderConversationId(params: unknown): string | undefined {
  return (
    readString(params, "threadId") ??
    readString(readObject(params, "thread"), "id") ??
    readString(params, "conversationId")
  );
}

export function readChildParentTurnId(
  context: CodexSessionContext,
  params: unknown,
): import("@bigbud/contracts").TurnId | undefined {
  const providerConversationId = readProviderConversationId(params);
  if (!providerConversationId) {
    return undefined;
  }
  return context.collabReceiverTurns.get(providerConversationId);
}

export function rememberCollabReceiverTurns(
  context: CodexSessionContext,
  params: unknown,
  parentTurnId: import("@bigbud/contracts").TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }
  const payload = readObject(params);
  const item = readObject(payload, "item") ?? payload;
  const itemType = readString(item, "type");
  // Codex 0.163 announces a spawned child only as `subAgentActivity` (`agentThreadId`); older
  // servers listed it in the spawn call's `receiverThreadIds`.
  const childThreadIds =
    itemType === "subAgentActivity"
      ? [readString(item, "agentThreadId")].filter((value): value is string => Boolean(value))
      : (readString(item, "type") ?? readString(item, "kind")) === "collabAgentToolCall"
        ? (readArray(item, "receiverThreadIds")
            ?.map((value) => (typeof value === "string" ? value : null))
            .filter((value): value is string => value !== null) ?? [])
        : [];
  for (const childThreadId of childThreadIds) {
    context.collabReceiverTurns.set(childThreadId, parentTurnId);
    if (!context.collabChildTurns.has(childThreadId)) {
      context.collabChildTurns.set(childThreadId, null);
      if (context.collabChildTurns.size > MAX_TRACKED_CHILD_THREADS) {
        context.collabChildTurns.delete(context.collabChildTurns.keys().next().value!);
      }
    }
  }
}

/** Bound on remembered child threads per session; the oldest are forgotten first. */
const MAX_TRACKED_CHILD_THREADS = 200;

/**
 * Records a known child thread's running turn from its own lifecycle notifications, which are
 * kept out of the parent session. Returns whether the notification belongs to a known child.
 */
export function trackCollabChildTurn(
  context: CodexSessionContext,
  method: string,
  providerThreadId: string | undefined,
  params: unknown,
): boolean {
  if (!providerThreadId || !context.collabChildTurns.has(providerThreadId)) return false;
  if (method === "turn/started") {
    const turnId = toTurnId(readString(readObject(params, "turn"), "id"));
    if (turnId) context.collabChildTurns.set(providerThreadId, turnId);
  } else if (method === "turn/completed") {
    context.collabChildTurns.set(providerThreadId, null);
  }
  return true;
}

export function shouldSuppressChildConversationNotification(method: string): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/aborted" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

export function readNotificationThreadId(method: string, params: unknown): string | undefined {
  const payload = readObject(params);
  if (method === "thread/started") {
    return readString(readObject(payload, "thread"), "id");
  }
  return readString(payload, "threadId");
}

// ---------------------------------------------------------------------------
// Thread snapshot parsing
// ---------------------------------------------------------------------------

export function parseThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
  const responseRecord = readObject(response);
  const thread = readObject(responseRecord, "thread");
  const threadIdRaw = readString(thread, "id") ?? readString(responseRecord, "threadId");
  if (!threadIdRaw) {
    throw new Error(`${method} response did not include a thread id.`);
  }
  const turnsRaw = readArray(thread, "turns") ?? readArray(responseRecord, "turns") ?? [];
  const turns = turnsRaw.map((turnValue, index) => {
    const turn = readObject(turnValue);
    const turnIdRaw = readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
    const turnId = TurnId.makeUnsafe(turnIdRaw);
    const items = readArray(turn, "items") ?? [];
    return {
      id: turnId,
      items,
    };
  });

  return {
    threadId: threadIdRaw,
    turns,
  };
}
