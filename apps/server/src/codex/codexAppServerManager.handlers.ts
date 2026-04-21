import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  ProviderRequestKind,
  type ProviderEvent,
} from "@bigbud/contracts";

import { classifyCodexStderrLine } from "./codexStderrClassifier";
import {
  type CodexSessionContext,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./codexAppServerManager.types";
import {
  isResponse,
  isServerNotification,
  isServerRequest,
  readBoolean,
  readChildParentTurnId,
  readObject,
  readRouteFields,
  readString,
  rememberCollabReceiverTurns,
  shouldSuppressChildConversationNotification,
} from "./codexAppServerManager.protocol";
import { normalizeProviderThreadId, toTurnId } from "./codexAppServerManager.utils";

// ---------------------------------------------------------------------------
// Process lifecycle listeners
// ---------------------------------------------------------------------------

export function attachProcessListeners(
  context: CodexSessionContext,
  callbacks: {
    onStdoutLine: (context: CodexSessionContext, line: string) => void;
    emitNotificationEvent: (context: CodexSessionContext, method: string, message: string) => void;
    updateSession: (
      context: CodexSessionContext,
      updates: Partial<import("@bigbud/contracts").ProviderSession>,
    ) => void;
    emitErrorEvent: (context: CodexSessionContext, method: string, message: string) => void;
    emitLifecycleEvent: (context: CodexSessionContext, method: string, message: string) => void;
    sessions: Map<import("@bigbud/contracts").ThreadId, CodexSessionContext>;
  },
): void {
  context.output.on("line", (line) => {
    callbacks.onStdoutLine(context, line);
  });

  context.child.stderr.on("data", (chunk: Buffer) => {
    const raw = chunk.toString();
    const lines = raw.split(/\r?\n/g);
    for (const rawLine of lines) {
      const classified = classifyCodexStderrLine(rawLine);
      if (!classified) {
        continue;
      }

      callbacks.emitNotificationEvent(context, "process/stderr", classified.message);
    }
  });

  context.child.on("error", (error) => {
    const message = error.message || "codex app-server process errored.";
    callbacks.updateSession(context, {
      status: "error",
      lastError: message,
    });
    callbacks.emitErrorEvent(context, "process/error", message);
  });

  context.child.on("exit", (code, signal) => {
    if (context.stopping) {
      return;
    }

    const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
    callbacks.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
      lastError: code === 0 ? context.session.lastError : message,
    });
    callbacks.emitLifecycleEvent(context, "session/exited", message);
    callbacks.sessions.delete(context.session.threadId);
  });
}

// ---------------------------------------------------------------------------
// stdout message routing
// ---------------------------------------------------------------------------

export function handleStdoutLine(
  context: CodexSessionContext,
  line: string,
  callbacks: {
    handleServerRequest: (context: CodexSessionContext, request: JsonRpcRequest) => void;
    handleServerNotification: (
      context: CodexSessionContext,
      notification: JsonRpcNotification,
    ) => void;
    handleResponse: (context: CodexSessionContext, response: JsonRpcResponse) => void;
    emitErrorEvent: (context: CodexSessionContext, method: string, message: string) => void;
  },
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    callbacks.emitErrorEvent(
      context,
      "protocol/parseError",
      "Received invalid JSON from codex app-server.",
    );
    return;
  }

  if (!parsed || typeof parsed !== "object") {
    callbacks.emitErrorEvent(
      context,
      "protocol/invalidMessage",
      "Received non-object protocol message.",
    );
    return;
  }

  if (isServerRequest(parsed)) {
    callbacks.handleServerRequest(context, parsed);
    return;
  }

  if (isServerNotification(parsed)) {
    callbacks.handleServerNotification(context, parsed);
    return;
  }

  if (isResponse(parsed)) {
    callbacks.handleResponse(context, parsed);
    return;
  }

  callbacks.emitErrorEvent(
    context,
    "protocol/unrecognizedMessage",
    "Received protocol message in an unknown shape.",
  );
}

// ---------------------------------------------------------------------------
// Server notification handler
// ---------------------------------------------------------------------------

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
  const rawRoute = readRouteFields(notification.params);
  rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
  const childParentTurnId = readChildParentTurnId(context, notification.params);
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
    const providerThreadId = normalizeProviderThreadId(
      readString(readObject(notification.params)?.thread, "id"),
    );
    if (providerThreadId) {
      callbacks.updateSession(context, { resumeCursor: { threadId: providerThreadId } });
    }
    return;
  }

  if (notification.method === "turn/started") {
    if (isChildConversation) {
      return;
    }
    const turnId = toTurnId(readString(readObject(notification.params)?.turn, "id"));
    callbacks.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
    });
    return;
  }

  if (notification.method === "turn/completed") {
    if (isChildConversation) {
      return;
    }
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

  if (notification.method === "error") {
    if (isChildConversation) {
      return;
    }
    const message = readString(readObject(notification.params)?.error, "message");
    const willRetry = readBoolean(notification.params, "willRetry");

    callbacks.updateSession(context, {
      status: willRetry ? "running" : "error",
      lastError: message ?? context.session.lastError,
    });
  }
}

// ---------------------------------------------------------------------------
// Server request handler
// ---------------------------------------------------------------------------

export function requestKindForMethod(method: string): ProviderRequestKind | undefined {
  if (method === "item/commandExecution/requestApproval") {
    return "command";
  }

  if (method === "item/fileRead/requestApproval") {
    return "file-read";
  }

  if (method === "item/fileChange/requestApproval") {
    return "file-change";
  }

  return undefined;
}

export function handleServerRequest(
  context: CodexSessionContext,
  request: JsonRpcRequest,
  callbacks: {
    emitEvent: (event: ProviderEvent) => void;
    writeMessage: (context: CodexSessionContext, message: unknown) => void;
  },
): void {
  const rawRoute = readRouteFields(request.params);
  const childParentTurnId = readChildParentTurnId(context, request.params);
  const effectiveTurnId = childParentTurnId ?? rawRoute.turnId;
  const requestKind = requestKindForMethod(request.method);
  let requestId: ApprovalRequestId | undefined;
  if (requestKind) {
    requestId = ApprovalRequestId.makeUnsafe(randomUUID());
    context.pendingApprovals.set(requestId, {
      requestId,
      jsonRpcId: request.id,
      method:
        requestKind === "command"
          ? "item/commandExecution/requestApproval"
          : requestKind === "file-read"
            ? "item/fileRead/requestApproval"
            : "item/fileChange/requestApproval",
      requestKind,
      threadId: context.session.threadId,
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
    });
  }

  if (request.method === "item/tool/requestUserInput") {
    requestId = ApprovalRequestId.makeUnsafe(randomUUID());
    context.pendingUserInputs.set(requestId, {
      requestId,
      jsonRpcId: request.id,
      threadId: context.session.threadId,
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
    });
  }

  callbacks.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: "request",
    provider: "codex",
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
    method: request.method,
    ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
    ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
    requestId,
    requestKind,
    payload: request.params,
  });

  if (requestKind) {
    return;
  }

  if (request.method === "item/tool/requestUserInput") {
    return;
  }

  callbacks.writeMessage(context, {
    id: request.id,
    error: {
      code: -32601,
      message: `Unsupported server request: ${request.method}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Response handler
// ---------------------------------------------------------------------------

export function handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
  const key = String(response.id);
  const pending = context.pending.get(key);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeout);
  context.pending.delete(key);

  if (response.error?.message) {
    pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
    return;
  }

  pending.resolve(response.result);
}
