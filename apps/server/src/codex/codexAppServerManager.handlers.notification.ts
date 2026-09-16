import { randomUUID } from "node:crypto";

import { EventId, type ProviderEvent } from "@bigbud/contracts";

import {
  type CodexSessionContext,
  type JsonRpcNotification,
} from "./codexAppServerManager.types.ts";
import {
  readBoolean,
  readChildParentTurnId,
  readNotificationThreadId,
  readObject,
  readRouteFields,
  readString,
  rememberCollabReceiverTurns,
  shouldSuppressChildConversationNotification,
} from "./codexAppServerManager.protocol.ts";
import { normalizeProviderThreadId, toTurnId } from "./codexAppServerManager.utils.ts";

export function handleServerNotification(
  context: CodexSessionContext,
  notification: JsonRpcNotification,
  callbacks: {
    emitEvent: (event: ProviderEvent) => void;
    updateSession: (
      context: CodexSessionContext,
      updates: Partial<import("@bigbud/contracts").ProviderSession>,
    ) => void;
  },
): void {
  context.mcpReadiness?.observe(notification);
  const rawRoute = readRouteFields(notification.params);
  rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
  const providerThreadId = readNotificationThreadId(notification.method, notification.params);
  const childParentTurnId =
    readChildParentTurnId(context, notification.params) ??
    (providerThreadId ? context.collabReceiverTurns.get(providerThreadId) : undefined);
  const isChildConversation = childParentTurnId !== undefined;
  if (isChildConversation && shouldSuppressChildConversationNotification(notification.method)) {
    return;
  }
  const textDelta =
    notification.method === "item/agentMessage/delta"
      ? readString(notification.params, "delta")
      : undefined;

  callbacks.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: "notification",
    provider: "codex",
    threadId: context.session.threadId,
    sessionEpoch: context.session.sessionEpoch!,
    createdAt: new Date().toISOString(),
    method: notification.method,
    ...((childParentTurnId ?? rawRoute.turnId)
      ? { turnId: childParentTurnId ?? rawRoute.turnId }
      : {}),
    ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
    textDelta,
    payload: notification.params,
  });

  if (notification.method === "thread/started") {
    const startedThreadId = normalizeProviderThreadId(
      readString(readObject(notification.params)?.thread, "id"),
    );
    if (startedThreadId) {
      callbacks.updateSession(context, { resumeCursor: { threadId: startedThreadId } });
    }
    return;
  }

  if (notification.method === "turn/started") {
    if (isChildConversation) return;
    const turnId = toTurnId(readString(readObject(notification.params)?.turn, "id"));
    callbacks.updateSession(context, { status: "running", activeTurnId: turnId });
    return;
  }

  if (notification.method === "turn/completed") {
    if (isChildConversation) return;
    context.collabReceiverTurns.clear();
    const turn = readObject(notification.params, "turn");
    const status = readString(turn, "status");
    const errorMessage = readString(readObject(turn, "error"), "message");
    callbacks.updateSession(context, {
      status: status === "failed" ? "error" : "ready",
      activeTurnId: undefined,
      lastError: errorMessage ?? context.session.lastError,
    });
    return;
  }

  if (notification.method === "error" && !isChildConversation) {
    const message = readString(readObject(notification.params)?.error, "message");
    const willRetry = readBoolean(notification.params, "willRetry");
    callbacks.updateSession(context, {
      status: willRetry ? "running" : "error",
      lastError: message ?? context.session.lastError,
    });
  }
}
