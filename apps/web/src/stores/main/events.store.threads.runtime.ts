import { type OrchestrationEvent } from "@bigbud/contracts";

import { mapMessage, mapProposedPlan, mapSession, mapTurnDiffSummary } from "./mappers.store";
import { type AppState } from "./main.store";
import {
  applyThreadReverted,
  buildLatestTurn,
  checkpointStatusToLatestTurnState,
  compareActivities,
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_PROPOSED_PLANS,
  rebindTurnDiffSummariesForAssistantMessage,
  updateThreadState,
} from "./helpers.store";
import { sanitizeThreadErrorMessage } from "../../rpc/transportError";
import { isStaleRunningSessionUpdate } from "./events.store.threads.runtime.logic";
import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant";
import { PROVIDER_CHECKING_SESSION_REASON } from "@bigbud/contracts/constants/providerRuntime.constant";
import { applyDelegationLinkedActivity } from "./events.store.delegations";
import { applyDelegatedChildRuntimeEvent } from "./events.store.delegatedRuntime";
import { demoteProviderAgentsForSession } from "./events.store.providerAgents";
import { prependSidebarRecentThreadId } from "./helpers.sidebar.store";
import {
  buildThreadMessageLatestTurn,
  getProviderTurnStartFailureDetail,
  upsertThreadMessage,
} from "./events.store.threads.runtime.messages";

export function applyThreadRuntimeEvent(
  state: AppState,
  event: OrchestrationEvent,
): AppState | undefined {
  state = applyDelegatedChildRuntimeEvent(state, event);
  switch (event.type) {
    case "thread.task-upserted":
      if (event.payload.task.kind !== "providerSubagent") return state;
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        providerAgents: [
          ...(thread.providerAgents ?? []).filter((agent) => agent.id !== event.payload.task.id),
          event.payload.task,
        ],
      }));
    case "thread.task-removed":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        providerAgents: (thread.providerAgents ?? []).filter(
          (agent) => agent.id !== event.payload.taskId,
        ),
      }));
    case "thread.message-sent": {
      const nextState = updateThreadState(state, event.payload.threadId, (thread) => {
        const message = mapMessage({
          id: event.payload.messageId,
          role: event.payload.role,
          text: event.payload.text,
          ...(event.payload.attachments !== undefined
            ? { attachments: event.payload.attachments }
            : {}),
          ...(event.payload.replyTo !== undefined ? { replyTo: event.payload.replyTo } : {}),
          ...(event.payload.originSegments !== undefined
            ? { originSegments: event.payload.originSegments }
            : {}),
          turnId: event.payload.turnId,
          streaming: event.payload.streaming,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        });
        const messages = upsertThreadMessage(thread, message, event);
        const currentSession = thread.session;
        const session =
          currentSession !== null &&
          message.role === "assistant" &&
          message.streaming &&
          message.turnId !== null &&
          currentSession.activeTurnId === message.turnId &&
          currentSession.reason === PROVIDER_CHECKING_SESSION_REASON
            ? {
                provider: currentSession.provider,
                status: "running" as const,
                orchestrationStatus: "running" as const,
                ...(currentSession.activeTurnId !== undefined
                  ? { activeTurnId: currentSession.activeTurnId }
                  : {}),
                createdAt: currentSession.createdAt,
                updatedAt: event.payload.updatedAt,
              }
            : currentSession;
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
          session,
          messages,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });
      const summary = nextState.sidebarThreadsById[event.payload.threadId];
      if (event.payload.role !== "user" || !summary || !isBuiltInChatsProject(summary.projectId)) {
        return nextState;
      }
      return {
        ...nextState,
        sidebarRecentThreadIds: prependSidebarRecentThreadId(
          nextState.sidebarRecentThreadIds,
          event.payload.threadId,
        ),
      };
    }

    case "thread.session-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const incomingSession = event.payload.session;
        const incomingActiveTurnId = incomingSession.activeTurnId ?? null;

        const hasNonStreamingAssistantMessageForTurn =
          incomingActiveTurnId !== null &&
          thread.messages.some(
            (msg) =>
              msg.turnId !== undefined &&
              msg.turnId === incomingActiveTurnId &&
              msg.role === "assistant" &&
              msg.streaming === false,
          );

        const isStaleRunningSession = isStaleRunningSessionUpdate({
          incomingStatus: incomingSession.status,
          incomingActiveTurnId,
          incomingReason: incomingSession.reason,
          latestTurn: thread.latestTurn,
          hasNonStreamingAssistantMessageForTurn,
        });

        const normalizedSession = isStaleRunningSession
          ? { ...incomingSession, status: "ready" as const, activeTurnId: null, reason: null }
          : incomingSession;

        const session = mapSession(normalizedSession);
        const providerAgents = demoteProviderAgentsForSession(
          thread.providerAgents,
          thread.session,
          normalizedSession,
        );

        return {
          ...thread,
          session,
          ...(providerAgents !== undefined ? { providerAgents } : {}),
          error: sanitizeThreadErrorMessage(incomingSession.lastError),
          latestTurn:
            normalizedSession.status === "running" && incomingActiveTurnId !== null
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: incomingActiveTurnId,
                  state:
                    thread.latestTurn?.turnId === incomingActiveTurnId &&
                    thread.latestTurn?.completedAt
                      ? thread.latestTurn.state
                      : "running",
                  requestedAt:
                    thread.latestTurn?.turnId === incomingActiveTurnId
                      ? thread.latestTurn.requestedAt
                      : incomingSession.updatedAt,
                  startedAt:
                    thread.latestTurn?.turnId === incomingActiveTurnId
                      ? (thread.latestTurn.startedAt ?? incomingSession.updatedAt)
                      : incomingSession.updatedAt,
                  completedAt:
                    thread.latestTurn?.turnId === incomingActiveTurnId
                      ? (thread.latestTurn.completedAt ?? null)
                      : null,
                  assistantMessageId:
                    thread.latestTurn?.turnId === incomingActiveTurnId
                      ? thread.latestTurn.assistantMessageId
                      : null,
                  sourceProposedPlan: thread.pendingSourceProposedPlan,
                })
              : thread.latestTurn,
          updatedAt: event.occurredAt,
        };
      });
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

    case "thread.turn-start-failed": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(thread.session
          ? {
              session: {
                ...thread.session,
                status: "error" as const,
                orchestrationStatus: "error" as const,
                activeTurnId: undefined,
                reason: event.payload.context,
                lastError: event.payload.detail,
                updatedAt: event.payload.createdAt,
              },
            }
          : {}),
        latestTurn:
          thread.latestTurn === null
            ? null
            : buildLatestTurn({
                previous: thread.latestTurn,
                turnId: thread.latestTurn.turnId,
                state: "error",
                requestedAt: thread.latestTurn.requestedAt,
                startedAt: thread.latestTurn.startedAt ?? event.payload.createdAt,
                completedAt: thread.latestTurn.completedAt ?? event.payload.createdAt,
                assistantMessageId: thread.latestTurn.assistantMessageId,
                sourceProposedPlan: thread.latestTurn.sourceProposedPlan,
              }),
        error: sanitizeThreadErrorMessage(event.payload.detail) ?? event.payload.detail,
        updatedAt: event.occurredAt,
      }));
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
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) =>
          applyThreadReverted(thread, {
            turnCount: event.payload.turnCount,
            occurredAt: event.occurredAt,
          }),
        { preserveLatestUserMessageAt: false },
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
        const providerTurnStartError = getProviderTurnStartFailureDetail(event.payload.activity);
        return applyDelegationLinkedActivity(
          {
            ...thread,
            activities,
            error: providerTurnStartError ?? thread.error,
            updatedAt: event.occurredAt,
          },
          event.payload.activity,
        );
      });
    }

    default:
      return undefined;
  }
}
