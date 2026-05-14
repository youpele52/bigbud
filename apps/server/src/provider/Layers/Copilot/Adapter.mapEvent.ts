/**
 * CopilotAdapter.mapEvent — SDK SessionEvent → ProviderRuntimeEvent mapping.
 *
 * Extracted from the main adapter module to keep `mapEvent` independently
 * testable without instantiating the full adapter factory.
 *
 * @module CopilotAdapter.mapEvent
 */
import {
  type EventId,
  type ProviderRuntimeEvent,
  TurnId,
  type UserInputQuestion,
} from "@bigbud/contracts";
import { type SessionEvent } from "@github/copilot-sdk";
import { Effect } from "effect";

import {
  USER_INPUT_QUESTION_ID,
  type ActiveCopilotSession,
  eventBase,
  normalizeUsage,
} from "./Adapter.types.ts";

/** Dependencies threaded into mapEvent as plain values. */
export interface MapEventDeps {
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly nextEventId: Effect.Effect<EventId>;
  readonly emit: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;
}

/**
 * Maps a raw Copilot SDK `SessionEvent` to zero or more `ProviderRuntimeEvent`s.
 * Pure with respect to the adapter factory — depends only on `session`, `event`,
 * and the three helpers threaded through `deps`.
 */
export const mapEvent = (
  deps: MapEventDeps,
  session: ActiveCopilotSession,
  event: SessionEvent,
): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> =>
  Effect.gen(function* () {
    const turnId = session.activeTurnId;
    const stamp = yield* deps.makeEventStamp();
    const raw = {
      source: "copilot.sdk.session-event" as const,
      method: event.type,
      payload: event,
    };

    switch (event.type) {
      case "assistant.turn_start": {
        const eventTurnId = TurnId.makeUnsafe(event.data.turnId);
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              turnId: eventTurnId,
              raw,
            }),
            type: "turn.started",
            payload: session.model ? { model: session.model } : {},
          },
        ];
      }
      case "assistant.message_delta":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.messageId,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: event.data.deltaContent,
            },
          },
        ];
      case "assistant.reasoning_delta":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.reasoningId,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: event.data.deltaContent,
            },
          },
        ];
      case "assistant.message":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.messageId,
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: event.data.content,
              data: event.data,
            },
          },
        ];
      case "assistant.reasoning":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.reasoningId,
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              status: "completed",
              title: "Assistant reasoning",
              detail: event.data.content,
              data: event.data,
            },
          },
        ];
      case "assistant.usage":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              raw,
            }),
            type: "thread.token-usage.updated",
            payload: { usage: normalizeUsage(event) },
          },
        ];
      case "session.idle": {
        const readyEventId = yield* deps.nextEventId;
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              raw,
            }),
            type: "turn.completed",
            payload: {
              state: event.data.aborted ? "interrupted" : "completed",
              ...(session.lastUsage ? { usage: session.lastUsage } : {}),
            },
          },
          {
            ...eventBase({
              eventId: readyEventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              raw,
            }),
            type: "session.state.changed",
            payload: { state: "ready", reason: "session.idle" },
          },
        ];
      }
      case "abort":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              raw,
            }),
            type: "turn.aborted",
            payload: { reason: event.data.reason },
          },
        ];
      case "session.error":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              raw,
            }),
            type: "runtime.error",
            payload: {
              message: event.data.message,
              class: "provider_error",
              detail: event.data,
            },
          },
        ];
      case "tool.execution_start": {
        const toolName = event.data.toolName ?? "";
        const isBrowserTool = /browser|navigate|screenshot|web_search|websearch/i.test(toolName);
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.toolCallId,
              raw,
            }),
            type: "item.started",
            payload: {
              itemType:
                event.data.mcpToolName || isBrowserTool ? "mcp_tool_call" : "dynamic_tool_call",
              status: "inProgress",
              title: event.data.toolName,
              ...(event.data.arguments ? { data: event.data.arguments } : {}),
            },
          },
        ];
      }
      case "tool.execution_complete":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              itemId: event.data.toolCallId,
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "dynamic_tool_call",
              status: event.data.success ? "completed" : "failed",
              title: "Tool call",
              ...((event.data.result?.detailedContent ?? event.data.result?.content)
                ? { detail: event.data.result?.detailedContent ?? event.data.result?.content }
                : {}),
              data: event.data,
            },
          },
        ];
      case "user_input.requested": {
        const question: UserInputQuestion = {
          id: USER_INPUT_QUESTION_ID,
          header: "Question",
          question: event.data.question,
          options: (event.data.choices ?? []).map((choice: string) => ({
            label: choice,
            description: choice,
          })),
        };
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              requestId: event.data.requestId,
              raw,
            }),
            type: "user-input.requested",
            payload: { questions: [question] },
          },
        ];
      }
      case "user_input.completed":
        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt: event.timestamp,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              requestId: event.data.requestId,
              raw,
            }),
            type: "user-input.resolved",
            payload: { answers: {} },
          },
        ];
      default:
        return [];
    }
  });
