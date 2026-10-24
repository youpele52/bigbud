import { randomUUID } from "node:crypto";

import { ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import { isBigbudPlanTrackingToolName } from "../../../orchestration-tools/threadPlanTrackingTool.shared.ts";
import type {
  ActivePiSession,
  PiEmitEvents,
  PiMakeEventStamp,
  PiRunPromise,
  PiStdoutEventHandler,
  PiSyntheticEventFn,
  PiWriteNativeEvent,
} from "./Adapter.types.ts";
import type { PiRpcStdoutMessage } from "./RpcProcess.ts";
import { appendTurnItem, eventBase, extractTextContent, normalizeString } from "./Adapter.utils.ts";
import {
  emitWithTurnAppend,
  handlePlanToolExecutionStart,
  handleExtensionUiRequest,
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
  handleTurnEnd,
} from "./Adapter.stream.handlers.ts";
import { settlePiAgentEnd } from "./Adapter.stream.agentLifecycle.ts";
import { settlePiRun } from "./Adapter.stream.settled.ts";
import { trackPiPromptQueue } from "./Adapter.stream.promptQueue.ts";
import { recoverMissingPiAgentEnd } from "./Adapter.stream.missingAgentEnd.ts";
import { handleRuntimeStatusEvent } from "./Adapter.stream.stdout.runtimeEvents.ts";
import { piUsageEvent } from "./Adapter.usage.ts";

export function makeHandleStdoutEvent(deps: {
  readonly emit: PiEmitEvents;
  readonly makeEventStamp: PiMakeEventStamp;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly runPromise: PiRunPromise;
  readonly sessions: Map<ThreadId, ActivePiSession>;
  readonly writeNativeEvent: PiWriteNativeEvent;
}): PiStdoutEventHandler {
  return Effect.fn("handleStdoutEvent")(function* (session, message: PiRpcStdoutMessage) {
    trackPiPromptQueue(session, message);
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
        session.agentRunning = true;
        session.completedTurnBoundary = undefined;
        session.missingAgentEndRecoveryToken = undefined;
        return yield* deps.emit([
          yield* deps.makeSyntheticEvent(
            session.threadId,
            session.sessionEpoch,
            "session.state.changed",
            {
              state: "running",
              reason: "agent_start",
            },
          ),
        ]);
      }
      case "turn_start": {
        session.updatedAt = createdAt;
        if (!session.activeTurnId) {
          return;
        }
        return yield* deps.emit([
          yield* deps.makeSyntheticEvent(
            session.threadId,
            session.sessionEpoch,
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
                  sessionEpoch: session.sessionEpoch,
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
                  sessionEpoch: session.sessionEpoch,
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

          const detail = extractTextContent(message.message);
          const events: ProviderRuntimeEvent[] = [];
          const usageEvent = piUsageEvent(session, message.message, itemId, createdAt, raw);
          if (usageEvent) events.push(usageEvent);

          events.push({
            ...eventBase({
              eventId: stamp.eventId,
              createdAt,
              threadId: session.threadId,
              sessionEpoch: session.sessionEpoch,
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
          yield* handleTurnEnd({
            emit: deps.emit,
            session,
            stamp: pendingTurnEnd.stamp,
            raw: pendingTurnEnd.raw,
            message: pendingTurnEnd.message,
          });
          return yield* recoverMissingPiAgentEnd({
            session,
            settle: () =>
              settlePiAgentEnd({
                emit: deps.emit,
                makeSyntheticEvent: deps.makeSyntheticEvent,
                session,
              }),
            reportExhausted: (recovery) =>
              deps
                .makeSyntheticEvent(session.threadId, session.sessionEpoch, "runtime.error", {
                  message: "Pi completion recovery exhausted",
                  class: "provider_error",
                  detail: {
                    turnId: recovery.turnId ?? null,
                    attempts: recovery.attempts,
                    class: recovery.class,
                  },
                })
                .pipe(Effect.flatMap((event) => deps.emit([event]))),
          });
        }

        if (role === "user" || role === "toolResult") {
          session.currentAssistantMessageId = undefined;
          appendTurnItem(session, message.message);
        }
        return;
      }
      case "tool_execution_start":
        if (isBigbudPlanTrackingToolName(message.toolName)) {
          return yield* handlePlanToolExecutionStart({
            emit: deps.emit,
            session,
            stamp,
            raw,
            message,
          });
        }
        return yield* handleToolExecutionStart({
          emit: deps.emit,
          session,
          stamp,
          raw,
          message,
        });
      case "tool_execution_update":
        if (isBigbudPlanTrackingToolName(message.toolName)) {
          return;
        }
        return yield* handleToolExecutionUpdate({
          emit: deps.emit,
          session,
          stamp,
          raw,
          message,
        });
      case "tool_execution_end":
        if (isBigbudPlanTrackingToolName(message.toolName)) {
          return;
        }
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
              session.sessionEpoch,
              "session.state.changed",
              {
                state: "running",
                reason: "assistant_message.pending_completion",
              },
              session.activeTurnId ? { turnId: session.activeTurnId } : undefined,
            ),
          ]);
        }
        yield* handleTurnEnd({
          emit: deps.emit,
          session,
          stamp,
          raw,
          message,
        });
        return yield* recoverMissingPiAgentEnd({
          session,
          settle: () =>
            settlePiAgentEnd({
              emit: deps.emit,
              makeSyntheticEvent: deps.makeSyntheticEvent,
              session,
            }),
          reportExhausted: (recovery) =>
            deps
              .makeSyntheticEvent(session.threadId, session.sessionEpoch, "runtime.error", {
                message: "Pi completion recovery exhausted",
                class: "provider_error",
                detail: {
                  turnId: recovery.turnId ?? null,
                  attempts: recovery.attempts,
                  class: recovery.class,
                },
              })
              .pipe(Effect.flatMap((event) => deps.emit([event]))),
        });
      case "agent_end": {
        if (session.process.supportsAgentSettled) return;
        return yield* settlePiAgentEnd({
          emit: deps.emit,
          makeSyntheticEvent: deps.makeSyntheticEvent,
          session,
        });
      }
      case "agent_settled":
        return yield* settlePiRun({ ...deps, session, aborted: message.aborted === true });
      case "queue_update":
      case "compaction_start":
      case "compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
      case "extension_error":
        return yield* handleRuntimeStatusEvent({
          emit: deps.emit,
          session,
          stamp,
          raw,
          message,
        });
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
