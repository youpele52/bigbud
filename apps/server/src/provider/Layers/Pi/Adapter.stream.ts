import { randomUUID } from "node:crypto";

import { EventId, ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import type {
  ActivePiSession,
  PiEmitEvents,
  PiMakeEventStamp,
  PiProcessExitHandler,
  PiRunPromise,
  PiStdoutEventHandler,
  PiSyntheticEventFn,
  PiWriteNativeEvent,
} from "./Adapter.types.ts";
import type { PiRpcStdoutMessage } from "./RpcProcess.ts";
import {
  appendTurnItem,
  eventBase,
  extractTextContent,
  normalizeString,
  normalizeUsage,
} from "./Adapter.utils.ts";
import {
  emitWithTurnAppend,
  handleExtensionUiRequest,
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
  handleTurnEnd,
} from "./Adapter.stream.handlers.ts";

export function makeHandleProcessExit(deps: {
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly sessions: Map<ThreadId, ActivePiSession>;
}): PiProcessExitHandler {
  return Effect.fn("handleProcessExit")(function* (session, detail) {
    if (!deps.sessions.has(session.threadId)) {
      return;
    }

    deps.sessions.delete(session.threadId);
    session.lastError = detail;
    session.activeTurnId = undefined;

    yield* Effect.logWarning("Pi RPC process exited", {
      threadId: session.threadId,
      detail,
    });

    yield* deps.emit([
      yield* deps.makeSyntheticEvent(session.threadId, "session.state.changed", {
        state: "stopped",
        reason: detail,
      }),
      yield* deps.makeSyntheticEvent(session.threadId, "session.exited", {
        reason: detail,
        recoverable: true,
        exitKind: "error",
      }),
    ]);
  });
}

export function makeHandleStdoutEvent(deps: {
  readonly emit: PiEmitEvents;
  readonly makeEventStamp: PiMakeEventStamp;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly runPromise: PiRunPromise;
  readonly sessions: Map<ThreadId, ActivePiSession>;
  readonly writeNativeEvent: PiWriteNativeEvent;
}): PiStdoutEventHandler {
  return Effect.fn("handleStdoutEvent")(function* (session, message: PiRpcStdoutMessage) {
    yield* deps.writeNativeEvent(session.threadId, message);

    if (
      message.type === "turn_start" ||
      message.type === "turn_end" ||
      message.type === "message_start" ||
      message.type === "message_end"
    ) {
      yield* Effect.logInfo("pi.lifecycle", {
        threadId: session.threadId,
        activeTurnId: session.activeTurnId,
        currentAssistantMessageId: session.currentAssistantMessageId,
        pendingTurnEnd: session.pendingTurnEnd !== undefined,
        messageType: message.type,
      });
    } else if (
      message.type === "message_update" &&
      message.assistantMessageEvent?.type === "text_delta"
    ) {
      yield* Effect.logDebug("pi.lifecycle.delta", {
        threadId: session.threadId,
        activeTurnId: session.activeTurnId,
        currentAssistantMessageId: session.currentAssistantMessageId,
        deltaLen: message.assistantMessageEvent.delta.length,
      });
    }

    const stamp = yield* deps.makeEventStamp();
    const createdAt = stamp.createdAt;
    const raw = {
      source: message.type === "response" ? "pi.rpc.response" : "pi.rpc.event",
      ...(message.type === "response" && normalizeString(message.command)
        ? { method: message.command }
        : {}),
      ...(normalizeString(message.type) ? { messageType: message.type } : {}),
      payload: message,
    } satisfies NonNullable<ProviderRuntimeEvent["raw"]>;

    switch (message.type) {
      case "agent_start": {
        session.updatedAt = createdAt;
        return;
      }
      case "turn_start": {
        session.updatedAt = createdAt;
        if (!session.activeTurnId) {
          return;
        }
        return yield* deps.emit([
          yield* deps.makeSyntheticEvent(
            session.threadId,
            "turn.started",
            {
              ...(session.model ? { model: session.model } : {}),
              ...(session.thinkingLevel ? { effort: session.thinkingLevel } : {}),
            },
            { turnId: session.activeTurnId },
          ),
        ]);
      }
      case "message_start": {
        // Always create a stable ID for the current message block.
        // Pi only includes role in message_end, not message_start.
        session.currentAssistantMessageId = `assistant-${randomUUID()}`;
        return;
      }
      case "message_update": {
        const assistantEvent = message.assistantMessageEvent;
        const itemId = session.currentAssistantMessageId;
        if (!assistantEvent || !itemId) {
          return;
        }

        if (assistantEvent.type === "text_delta" && assistantEvent.delta.length > 0) {
          return yield* emitWithTurnAppend({
            emit: deps.emit,
            session,
            events: [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
                  itemId,
                  raw,
                }),
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: assistantEvent.delta,
                  ...(typeof assistantEvent.contentIndex === "number"
                    ? { contentIndex: assistantEvent.contentIndex }
                    : {}),
                },
              },
            ],
          });
        }

        if (assistantEvent.type === "thinking_delta" && assistantEvent.delta.length > 0) {
          return yield* emitWithTurnAppend({
            emit: deps.emit,
            session,
            events: [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
                  itemId,
                  raw,
                }),
                type: "content.delta",
                payload: {
                  streamKind: "reasoning_text",
                  delta: assistantEvent.delta,
                  ...(typeof assistantEvent.contentIndex === "number"
                    ? { contentIndex: assistantEvent.contentIndex }
                    : {}),
                },
              },
            ],
          });
        }

        return;
      }
      case "message_end": {
        const role = normalizeString(message.message.role);
        if (role === "assistant") {
          const itemId = session.currentAssistantMessageId ?? `assistant-${randomUUID()}`;
          session.currentAssistantMessageId = undefined;

          const usage = normalizeUsage(message.message.usage);
          if (usage) {
            session.lastUsage = usage;
          }

          const detail = extractTextContent(message.message);
          const events: ProviderRuntimeEvent[] = [];
          if (usage) {
            events.push({
              ...eventBase({
                eventId: EventId.makeUnsafe(randomUUID()),
                createdAt,
                threadId: session.threadId,
                ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
                itemId,
                raw,
              }),
              type: "thread.token-usage.updated",
              payload: { usage },
            });
          }

          events.push({
            ...eventBase({
              eventId: stamp.eventId,
              createdAt,
              threadId: session.threadId,
              ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
              itemId,
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: (() => {
                const stopReason = normalizeString(message.message.stopReason);
                return stopReason === "error" || stopReason === "aborted" ? "failed" : "completed";
              })(),
              title: "Assistant message",
              ...(detail ? { detail } : {}),
              data: message.message,
            },
          });
          yield* emitWithTurnAppend({ emit: deps.emit, session, events });
          const pendingTurnEnd = session.pendingTurnEnd;
          if (!pendingTurnEnd) {
            return;
          }
          session.pendingTurnEnd = undefined;
          return yield* handleTurnEnd({
            emit: deps.emit,
            session,
            stamp: pendingTurnEnd.stamp,
            raw: pendingTurnEnd.raw,
            message: pendingTurnEnd.message,
          });
        }

        if (role === "user" || role === "toolResult") {
          session.currentAssistantMessageId = undefined;
          appendTurnItem(session, message.message);
        }
        return;
      }
      case "tool_execution_start":
        return yield* handleToolExecutionStart({
          emit: deps.emit,
          session,
          stamp,
          raw,
          message,
        });
      case "tool_execution_update":
        return yield* handleToolExecutionUpdate({
          emit: deps.emit,
          session,
          stamp,
          raw,
          message,
        });
      case "tool_execution_end":
        return yield* handleToolExecutionEnd({
          emit: deps.emit,
          session,
          stamp,
          raw,
          message,
        });
      case "turn_end":
        if (session.currentAssistantMessageId) {
          session.pendingTurnEnd = { stamp, raw, message };
          return yield* deps.emit([
            yield* deps.makeSyntheticEvent(
              session.threadId,
              "session.state.changed",
              {
                state: "running",
                reason: "assistant_message.pending_completion",
              },
              session.activeTurnId ? { turnId: session.activeTurnId } : undefined,
            ),
          ]);
        }
        return yield* handleTurnEnd({
          emit: deps.emit,
          session,
          stamp,
          raw,
          message,
        });
      case "agent_end": {
        session.updatedAt = createdAt;
        return;
      }
      case "extension_ui_request":
        return yield* handleExtensionUiRequest({
          emit: deps.emit,
          makeSyntheticEvent: deps.makeSyntheticEvent,
          runPromise: deps.runPromise,
          session,
          sessions: deps.sessions,
          message,
        });
      case "response":
      default:
        yield* Effect.logDebug("Pi RPC unhandled message type", {
          threadId: session.threadId,
          messageType: message.type,
        });
        return;
    }
  });
}
