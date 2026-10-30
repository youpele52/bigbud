import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  ProviderRequestKind,
  type ProviderEvent,
} from "@bigbud/contracts";

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
  readChildParentTurnId,
  readObject,
  readProviderConversationId,
  readRouteFields,
  readString,
} from "./codexAppServerManager.protocol";
import { CodexRpcError, codexRequestKey } from "./codexAppServerManager.errors.ts";

export { attachProcessListeners } from "./codexAppServerManager.handlers.lifecycle.ts";
export { handleServerNotification } from "./codexAppServerManager.handlers.notification.ts";

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
    writeMessage: (context: CodexSessionContext, message: unknown) => void | Promise<void>;
    isCurrent?: () => boolean;
  },
): void {
  if (context.stopping) return;
  const rawRoute = readRouteFields(request.params);
  const childParentTurnId = readChildParentTurnId(context, request.params);
  const effectiveTurnId = childParentTurnId ?? rawRoute.turnId;
  const requestKind = requestKindForMethod(request.method);
  const supported =
    requestKind ||
    request.method === "item/tool/requestUserInput" ||
    (request.method === "item/tool/call" && context.dynamicToolCallHandler);
  if (!supported) {
    callbacks.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      sessionEpoch: context.session.sessionEpoch!,
      createdAt: new Date().toISOString(),
      method: "session/unsupportedRequest",
      message: `Unsupported Codex server request '${request.method}' was denied; no actionable permission was opened.`,
    });
    void Promise.resolve(
      callbacks.writeMessage(context, {
        id: request.id,
        error: { code: -32601, message: `Unsupported server request: ${request.method}` },
      }),
    ).catch(() => undefined);
    return;
  }
  const nativeIdentity = {
    nativeThreadId: readProviderConversationId(request.params),
    nativeTurnId: rawRoute.turnId,
    epoch: context.session.sessionEpoch,
    state: "pending" as const,
  };
  if (requestKind || request.method === "item/tool/requestUserInput") {
    const duplicate = [
      ...context.pendingApprovals.values(),
      ...context.pendingUserInputs.values(),
    ].some(
      (pending) =>
        pending.jsonRpcId === request.id &&
        pending.nativeThreadId === nativeIdentity.nativeThreadId &&
        pending.epoch === nativeIdentity.epoch,
    );
    if (duplicate) return; // In particular, never reopen/resubmit an unconfirmed response.
  }
  let requestId: ApprovalRequestId | undefined;
  if (requestKind) {
    requestId = ApprovalRequestId.makeUnsafe(randomUUID());
    context.pendingApprovals.set(requestId, {
      requestId,
      jsonRpcId: request.id,
      ...nativeIdentity,
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
      ...nativeIdentity,
      threadId: context.session.threadId,
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
    });
  }

  callbacks.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: requestId ? "request" : "notification",
    provider: "codex",
    threadId: context.session.threadId,
    sessionEpoch: context.session.sessionEpoch!,
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

  if (request.method === "item/tool/call" && context.dynamicToolCallHandler) {
    context.pendingToolCalls = (context.pendingToolCalls ?? 0) + 1;
    let delivered = false;
    const params = readObject(request.params);
    const namespace = readString(params, "namespace");
    const sourceMessageId = readString(params, "sourceMessageId");
    void context
      .dynamicToolCallHandler({
        requestId: request.id,
        tool: readString(params, "tool") ?? "",
        arguments: params?.arguments,
        ...(namespace ? { namespace } : {}),
        ...(sourceMessageId ? { sourceMessageId } : {}),
      })
      .then(
        async (result) => {
          if (context.stopping || callbacks.isCurrent?.() === false) return;
          await callbacks.writeMessage(context, {
            id: request.id,
            result,
          });
          delivered = true;
        },
        async (error) => {
          if (context.stopping || callbacks.isCurrent?.() === false) return;
          await callbacks.writeMessage(context, {
            id: request.id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          });
          delivered = true;
        },
      )
      .finally(() => {
        if (delivered) context.pendingToolCalls = Math.max(0, (context.pendingToolCalls ?? 1) - 1);
      })
      .catch(() => undefined);
    return;
  }
}

// ---------------------------------------------------------------------------
// Response handler
// ---------------------------------------------------------------------------

export function handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
  const key = codexRequestKey(context, response.id);
  const pending = context.pending.get(key);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeout);
  context.pending.delete(key);

  if (response.error !== undefined) {
    // Invalid-method/params are pre-dispatch rejections. Internal errors may follow a commit.
    const definite = response.error?.code === -32601 || response.error?.code === -32602;
    pending.reject(
      new CodexRpcError(
        pending.method,
        context.session.sessionEpoch,
        definite ? "definite-rejection" : "possibly-applied",
        `${pending.method} failed: ${response.error?.message ?? "RPC error"}`,
        { code: response.error?.code, data: response.error?.data },
      ),
    );
    return;
  }

  if (!("result" in response)) {
    pending.reject(
      new CodexRpcError(
        pending.method,
        context.session.sessionEpoch,
        "possibly-applied",
        `${pending.method} returned a malformed acknowledgement.`,
      ),
    );
    return;
  }
  pending.resolve(response.result);
}
