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
  trackCollabChildTurn,
} from "./codexAppServerManager.protocol.ts";
import { normalizeProviderThreadId, toTurnId } from "./codexAppServerManager.utils.ts";
import {
  observeManualCompact,
  takeCodexCompactionProof,
} from "./codexAppServerManager.controls.state.ts";
import { codexSessionEvent } from "./codexAppServerManager.events.ts";
import { CODEX_COMPACTION_COMPLETED } from "../provider/Services/ProviderCompaction.ts";

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
  if (context.stopping) return;
  const maintenance = observeManualCompact(context, notification);
  const proof = takeCodexCompactionProof(context);
  if (proof)
    callbacks.emitEvent({
      ...codexSessionEvent(
        context,
        "notification",
        CODEX_COMPACTION_COMPLETED,
        "Native compaction finished; awaiting durable proof.",
      ),
      payload: proof,
    });
  if (maintenance) {
    context.historyGeneration = (context.historyGeneration ?? 0) + 1;
    return;
  }
  if (
    /^(thread\/(compacted|started|reverted|status\/changed)|turn\/|item\/)/.test(
      notification.method,
    )
  ) {
    context.historyGeneration = (context.historyGeneration ?? 0) + 1;
  }
  if (notification.method === "serverRequest/resolved") {
    const params = readObject(notification.params);
    const nativeId = params?.requestId;
    const nativeThreadId = readString(params, "threadId");
    if (typeof nativeId !== "string" && typeof nativeId !== "number") return;
    for (const requests of [context.pendingApprovals, context.pendingUserInputs]) {
      for (const [requestId, pending] of requests) {
        if (
          pending.jsonRpcId !== nativeId ||
          pending.nativeThreadId !== nativeThreadId ||
          pending.epoch !== context.session.sessionEpoch
        )
          continue;
        requests.delete(requestId);
        // Submitted UI was closed only after its write completed; don't resolve it twice.
        if (pending.uiClosed) return;
        const requestKind =
          "requestKind" in pending &&
          (pending.requestKind === "command" ||
            pending.requestKind === "file-read" ||
            pending.requestKind === "file-change")
            ? pending.requestKind
            : undefined;
        callbacks.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "codex",
          threadId: context.session.threadId,
          sessionEpoch: context.session.sessionEpoch!,
          createdAt: new Date().toISOString(),
          method: notification.method,
          requestId,
          turnId: pending.turnId,
          itemId: pending.itemId,
          ...(requestKind ? { requestKind } : {}),
          payload: { ...params, interaction: "requestKind" in pending ? "approval" : "user-input" },
        });
        return;
      }
    }
    return;
  }
  context.mcpReadiness?.observe(notification);
  const rawRoute = readRouteFields(notification.params);
  if (
    notification.method === "turn/completed" &&
    context.session.activeTurnId &&
    rawRoute.turnId &&
    rawRoute.turnId !== context.session.activeTurnId &&
    readNotificationThreadId(notification.method, notification.params) ===
      readString(context.session.resumeCursor, "threadId")
  )
    return;
  rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
  const providerThreadId = readNotificationThreadId(notification.method, notification.params);
  const childParentTurnId =
    readChildParentTurnId(context, notification.params) ??
    (providerThreadId ? context.collabReceiverTurns.get(providerThreadId) : undefined);
  const isChildConversation = childParentTurnId !== undefined;
  // A known child keeps its lifecycle out of the parent session even after the parent turn
  // ended, while its running turn is remembered for thread Stop.
  const childTurn = trackCollabChildTurn(
    context,
    notification.method,
    providerThreadId,
    notification.params,
  );
  if (childTurn === "stale") return;
  const suppressParentLifecycle =
    (isChildConversation || childTurn === "known") &&
    shouldSuppressChildConversationNotification(notification.method);
  const forwardChildTurn =
    suppressParentLifecycle &&
    (notification.method === "turn/started" ||
      notification.method === "turn/completed" ||
      notification.method === "turn/aborted");
  if (
    providerThreadId &&
    providerThreadId !== readString(context.session.resumeCursor, "threadId") &&
    !isChildConversation &&
    childTurn !== "known" &&
    (shouldSuppressChildConversationNotification(notification.method) ||
      notification.method === "error")
  )
    return;
  if (suppressParentLifecycle && !forwardChildTurn) return;
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
    // Child lifecycle is visible to the subagent tracker, never to parent turn handlers.
    method:
      forwardChildTurn ||
      (notification.method === "error" && (isChildConversation || childTurn === "known"))
        ? `subagent/${notification.method}`
        : notification.method,
    ...((childParentTurnId ?? rawRoute.turnId)
      ? { turnId: childParentTurnId ?? rawRoute.turnId }
      : {}),
    ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
    textDelta,
    payload: notification.params,
  });

  if (suppressParentLifecycle) return;

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
    if (
      isChildConversation ||
      providerThreadId !== readString(context.session.resumeCursor, "threadId")
    )
      return;
    const turnId = toTurnId(readString(readObject(notification.params)?.turn, "id"));
    context.ownedTurnId = turnId;
    context.retryingTurnId = undefined;
    callbacks.updateSession(context, { status: "running", activeTurnId: turnId });
    return;
  }

  if (notification.method === "turn/completed") {
    if (
      isChildConversation ||
      providerThreadId !== readString(context.session.resumeCursor, "threadId")
    )
      return;
    context.collabReceiverTurns.clear();
    const turn = readObject(notification.params, "turn");
    context.completedTurnId = toTurnId(readString(turn, "id"));
    context.retryingTurnId = undefined;
    const status = readString(turn, "status");
    const errorMessage = readString(readObject(turn, "error"), "message");
    callbacks.updateSession(context, {
      status: status === "failed" ? "error" : "ready",
      activeTurnId: undefined,
      lastError: errorMessage ?? context.session.lastError,
    });
    return;
  }

  if (notification.method === "error" && !isChildConversation && childTurn !== "known") {
    const message = readString(readObject(notification.params)?.error, "message");
    const willRetry = readBoolean(notification.params, "willRetry");
    if (willRetry && providerThreadId === readString(context.session.resumeCursor, "threadId"))
      context.retryingTurnId = rawRoute.turnId ?? context.session.activeTurnId;
    callbacks.updateSession(context, {
      status: willRetry ? "running" : "error",
      lastError: message ?? context.session.lastError,
    });
  }
}
