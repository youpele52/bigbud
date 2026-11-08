import type { OrchestrationEvent } from "@bigbud/contracts";

import type { Thread } from "../../models/types";
import type { AppState } from "./main.store";
import { sanitizeThreadErrorMessage } from "../../rpc/transportError";
import { buildLatestTurn, MAX_THREAD_MESSAGES } from "./helpers.store";
import {
  boundMessageText,
  resolveUpsertedMessageText,
  withoutTextBounds,
} from "./messageText.store";

export function getProviderTurnStartFailureDetail(
  activity: Thread["activities"][number],
): string | null {
  if (activity.kind !== "provider.turn.start.failed") return null;
  const detail =
    typeof activity.payload === "object" &&
    activity.payload !== null &&
    "detail" in activity.payload &&
    typeof activity.payload.detail === "string"
      ? activity.payload.detail
      : activity.summary;
  return sanitizeThreadErrorMessage(detail) ?? activity.summary;
}

export function upsertThreadMessage(
  thread: Thread,
  message: Thread["messages"][number],
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): Thread["messages"] {
  const existingMessage = thread.messages.find((entry) => entry.id === message.id);
  const messages = existingMessage
    ? thread.messages.map((entry) =>
        entry.id !== message.id
          ? entry
          : {
              ...withoutTextBounds(entry),
              ...resolveUpsertedMessageText(entry, message, event.payload.replace === true),
              streaming: message.streaming,
              ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
              ...(message.streaming
                ? entry.completedAt !== undefined
                  ? { completedAt: entry.completedAt }
                  : {}
                : message.completedAt !== undefined
                  ? { completedAt: message.completedAt }
                  : {}),
              ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
              ...(message.replyTo !== undefined
                ? { replyTo: message.replyTo }
                : entry.replyTo !== undefined
                  ? { replyTo: entry.replyTo }
                  : {}),
              ...(message.originSegments !== undefined
                ? { originSegments: message.originSegments }
                : entry.originSegments !== undefined
                  ? { originSegments: entry.originSegments }
                  : {}),
            },
      )
    : [...thread.messages, { ...message, ...boundMessageText(message.text) }];
  return messages.slice(-MAX_THREAD_MESSAGES);
}

export function buildThreadMessageLatestTurn(
  thread: Thread,
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): Thread["latestTurn"] {
  if (event.payload.role !== "assistant" || event.payload.turnId === null) return thread.latestTurn;
  if (thread.latestTurn !== null && thread.latestTurn.turnId !== event.payload.turnId) {
    return thread.latestTurn;
  }
  return buildLatestTurn({
    previous: thread.latestTurn,
    turnId: event.payload.turnId,
    state: event.payload.streaming
      ? "running"
      : thread.latestTurn?.state === "interrupted"
        ? "interrupted"
        : thread.latestTurn?.state === "error"
          ? "error"
          : "completed",
    requestedAt:
      thread.latestTurn?.turnId === event.payload.turnId
        ? thread.latestTurn.requestedAt
        : event.payload.createdAt,
    startedAt:
      thread.latestTurn?.turnId === event.payload.turnId
        ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
        : event.payload.createdAt,
    sourceProposedPlan: thread.pendingSourceProposedPlan,
    completedAt: event.payload.streaming
      ? thread.latestTurn?.turnId === event.payload.turnId
        ? (thread.latestTurn.completedAt ?? null)
        : null
      : event.payload.updatedAt,
    assistantMessageId: event.payload.messageId,
  });
}

/**
 * A thread known only from its summary records a user message as its latest activity without
 * storing the transcript; opening it re-hydrates the transcript from the server.
 */
export function bumpSummaryLatestUserMessageAt(
  state: AppState,
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): AppState {
  const summary = state.sidebarThreadsById[event.payload.threadId];
  if (event.payload.role !== "user" || !summary) return state;
  const previous = summary.latestUserMessageAt;
  if (previous !== null && previous >= event.payload.createdAt) return state;
  return {
    ...state,
    sidebarThreadsById: {
      ...state.sidebarThreadsById,
      [event.payload.threadId]: { ...summary, latestUserMessageAt: event.payload.createdAt },
    },
  };
}
