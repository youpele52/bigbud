import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { Thread } from "../models/types";
import { isCurrentRunOwnedAgent } from "../logic/thread/threadBackgroundWork.logic";

export interface MessageNotificationObservation {
  messageId: string;
  turnId: string | null;
  text: string;
  completedAt: string | null;
}

export interface ThreadNotificationObservation {
  messages: MessageNotificationObservation[];
  settledTurnId?: string;
  settledSessionEpoch?: number;
  baselineSequence?: number;
  lastSettlementSequence?: number;
  blockedTurnId?: string;
}

export function invalidateNotificationEpoch(previous: Thread, next: Thread): Thread {
  const observation = next.notificationObservation;
  if ((previous.session?.sessionEpoch ?? 0) === (next.session?.sessionEpoch ?? 0) || !observation)
    return next;
  const {
    settledTurnId: _turn,
    settledSessionEpoch: _epoch,
    blockedTurnId: _blocked,
    ...retained
  } = observation;
  return { ...next, notificationObservation: retained };
}

const MAX_MESSAGES = 32;
const MAX_PREVIEW = 140;

/** Called only by live event reduction, never by summary/detail hydration. */
export function observeThreadNotification(
  previous: Thread,
  next: Thread,
  event: OrchestrationEvent,
): Thread {
  let observation = invalidateNotificationEpoch(previous, next).notificationObservation;
  if (event.type === "thread.message-sent" && event.payload.role === "assistant") {
    const payload = event.payload;
    const messages = observation?.messages ?? [];
    const existing = messages.find((message) => message.messageId === payload.messageId);
    // Hydrated history and duplicate finals must not acquire a new live observation.
    const hydrated = previous.messages.find((message) => message.id === payload.messageId);
    if (!existing?.completedAt && !(hydrated && !hydrated.streaming)) {
      const text = payload.streaming
        ? `${payload.replace ? "" : (existing?.text ?? "")}${payload.text}`.slice(0, MAX_PREVIEW)
        : (payload.text || existing?.text || hydrated?.text || "").slice(0, MAX_PREVIEW);
      observation = {
        ...observation,
        messages: [
          ...messages.filter((message) => message.messageId !== payload.messageId),
          {
            messageId: payload.messageId,
            turnId: payload.turnId,
            text,
            completedAt: payload.streaming ? null : payload.updatedAt,
          },
        ].slice(-MAX_MESSAGES),
      };
    }
  }
  if (
    event.type === "thread.turn-settled" &&
    next.latestTurn?.turnId === event.payload.turnId &&
    next.latestTurn.terminalOutcome === event.payload.outcome &&
    event.payload.sessionEpoch === (next.session?.sessionEpoch ?? 0) &&
    event.sequence >
      Math.max(observation?.baselineSequence ?? 0, observation?.lastSettlementSequence ?? 0)
  ) {
    observation = {
      ...observation,
      messages: observation?.messages ?? [],
      settledTurnId: event.payload.turnId,
      settledSessionEpoch: event.payload.sessionEpoch,
      lastSettlementSequence: event.sequence,
    };
  }
  // Disappearance is not settlement, including task removal and bounded membership eviction.
  if (
    previous.latestTurn &&
    previous.providerAgents?.some(
      (task) =>
        isCurrentRunOwnedAgent(previous, task) &&
        task.status !== "completed" &&
        !next.providerAgents?.some((candidate) => candidate.id === task.id),
    )
  ) {
    observation = {
      ...observation,
      messages: observation?.messages ?? [],
      blockedTurnId: previous.latestTurn.turnId,
    };
  }
  return !observation || observation === next.notificationObservation
    ? next
    : { ...next, notificationObservation: observation };
}
