import { type OrchestrationEvent } from "@bigbud/contracts";

import { mapMessage, mapProposedPlan, mapSession, mapTurnDiffSummary } from "./mappers.store";
import { type AppState } from "./main.store";
import { type Thread } from "../../models/types";
import {
  applyThreadReverted,
  buildLatestTurn,
  checkpointStatusToLatestTurnState,
  compareActivities,
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
  rebindTurnDiffSummariesForAssistantMessage,
  updateThreadState,
} from "./helpers.store";
import { sanitizeThreadErrorMessage } from "../../rpc/transportError";

export function applyThreadRuntimeEvent(
  state: AppState,
  event: OrchestrationEvent,
): AppState | undefined {
  switch (event.type) {
    case "thread.message-sent": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const message = mapMessage({
          id: event.payload.messageId,
          role: event.payload.role,
          text: event.payload.text,
          ...(event.payload.attachments !== undefined
            ? { attachments: event.payload.attachments }
            : {}),
          ...(event.payload.replyTo !== undefined ? { replyTo: event.payload.replyTo } : {}),
          turnId: event.payload.turnId,
          streaming: event.payload.streaming,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        });
        const messages = upsertThreadMessage(thread, message, event);
        const turnDiffSummaries =
          event.payload.role === "assistant" && event.payload.turnId !== null
            ? rebindTurnDiffSummariesForAssistantMessage(
                thread.turnDiffSummaries,
                event.payload.turnId,
                event.payload.messageId,
              )
            : thread.turnDiffSummaries;
        const latestTurn = buildThreadMessageLatestTurn(thread, event);
        return {
          ...thread,
          messages,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.session-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        session: mapSession(event.payload.session),
        error: sanitizeThreadErrorMessage(event.payload.session.lastError),
        latestTurn:
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.session.activeTurnId,
                state: "running",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.assistantMessageId
                    : null,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn,
        updatedAt: event.occurredAt,
      }));
    }

    case "thread.session-stop-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) =>
        thread.session === null
          ? thread
          : {
              ...thread,
              session: {
                ...thread.session,
                status: "closed",
                orchestrationStatus: "stopped",
                activeTurnId: undefined,
                updatedAt: event.payload.createdAt,
              },
              updatedAt: event.occurredAt,
            },
      );
    }

    case "thread.proposed-plan-upserted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
          proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-MAX_THREAD_PROPOSED_PLANS);
        return {
          ...thread,
          proposedPlans,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.turn-diff-completed": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const checkpoint = mapTurnDiffSummary({
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          status: event.payload.status,
          files: event.payload.files,
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        });
        const existing = thread.turnDiffSummaries.find(
          (entry) => entry.turnId === checkpoint.turnId,
        );
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return thread;
        }
        const turnDiffSummaries = [
          ...thread.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const latestTurn =
          thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: checkpointStatusToLatestTurnState(event.payload.status),
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: event.payload.assistantMessageId,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn;
        return {
          ...thread,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.reverted": {
      return updateThreadState(state, event.payload.threadId, (thread) =>
        applyThreadReverted(thread, {
          turnCount: event.payload.turnCount,
          occurredAt: event.occurredAt,
        }),
      );
    }

    case "thread.activity-appended": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const activities = [
          ...thread.activities.filter((activity) => activity.id !== event.payload.activity.id),
          { ...event.payload.activity },
        ]
          .toSorted(compareActivities)
          .slice(-MAX_THREAD_ACTIVITIES);
        return {
          ...thread,
          activities,
          updatedAt: event.occurredAt,
        };
      });
    }

    default:
      return undefined;
  }
}

function upsertThreadMessage(
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
              ...entry,
              text:
                event.payload.replace === true
                  ? message.text
                  : message.streaming
                    ? `${entry.text}${message.text}`
                    : message.text.length > 0
                      ? message.text
                      : entry.text,
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
            },
      )
    : [...thread.messages, message];
  return messages.slice(-MAX_THREAD_MESSAGES);
}

function buildThreadMessageLatestTurn(
  thread: Thread,
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): Thread["latestTurn"] {
  if (event.payload.role !== "assistant" || event.payload.turnId === null) {
    return thread.latestTurn;
  }
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
