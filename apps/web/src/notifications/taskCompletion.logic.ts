import type { Thread } from "../models/types";
import { isVisibleThread } from "../logic/thread/threadVisibility.logic";
import { derivePendingApprovals, derivePendingUserInputs } from "../logic/session";
import { isThreadCompletedStatus } from "../logic/thread/threadCompletion.logic";
import {
  hasCurrentRunActionablePlan,
  hasUnsettledCurrentRunWork,
} from "../logic/thread/threadBackgroundWork.logic";

export interface CompletedThreadCandidate {
  threadId: string;
  projectId: string;
  title: string;
  completedAt: string;
  assistantSummary: string | null;
  kind?: "update" | "completed";
  notificationKey?: string;
  messageId?: string | undefined;
}

const ASSISTANT_SUMMARY_MAX_LENGTH = 140;

function isCompletedThreadStatusFromThread(thread: Thread): boolean {
  return isThreadCompletedStatus({
    interactionMode: thread.interactionMode,
    latestTurn: thread.latestTurn,
    session: thread.session,
    hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
    hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
    hasActionableProposedPlan: hasCurrentRunActionablePlan(thread),
  });
}

/**
 * Extracts the last assistant message text from a thread and trims it to a
 * reasonable notification body length.
 */
export function summarizeLatestAssistantMessage(thread: Thread): string | null {
  const messages = thread.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.role === "assistant" && message.turnId === thread.latestTurn?.turnId) {
      const text = message.text.trim();
      if (text.length === 0) continue;
      return text.length > ASSISTANT_SUMMARY_MAX_LENGTH
        ? `${text.slice(0, ASSISTANT_SUMMARY_MAX_LENGTH)}…`
        : text;
    }
  }
  return null;
}

/**
 * Diffs two thread snapshots and returns candidates for completed-task
 * notifications. A candidate is emitted when:
 *   - The thread exists in both snapshots.
 *   - Live native proof confirms successful settlement of this exact root run.
 *   - No owned current-run task, descendant, or pending interaction remains unsettled.
 *   - The previous snapshot was not already eligible (including descendant changes).
 */
export function collectCompletedThreadCandidates(
  previousThreads: Thread[],
  nextThreads: Thread[],
): CompletedThreadCandidate[] {
  const previousById = new Map(previousThreads.map((t) => [t.id, t]));
  const nextById = new Map(nextThreads.map((t) => [t.id, t]));
  const candidates: CompletedThreadCandidate[] = [];

  for (const next of nextThreads) {
    if (!isVisibleThread(next)) {
      continue;
    }
    const nextTurn = next.latestTurn;
    if (
      !nextTurn?.completedAt ||
      nextTurn.terminalOutcome !== "completed" ||
      next.notificationObservation?.settledTurnId !== nextTurn.turnId ||
      next.notificationObservation.settledSessionEpoch !== (next.session?.sessionEpoch ?? 0) ||
      hasUnsettledCurrentRunWork(next, nextById)
    ) {
      continue;
    }

    const previous = previousById.get(next.id);
    if (!previous) {
      continue;
    }

    if (
      !isCompletedThreadStatusFromThread(next) ||
      (previous.latestTurn?.turnId === nextTurn.turnId &&
        previous.latestTurn.terminalOutcome === "completed" &&
        previous.notificationObservation?.settledTurnId === nextTurn.turnId &&
        previous.notificationObservation.settledSessionEpoch ===
          (previous.session?.sessionEpoch ?? 0) &&
        previous.notificationObservation.settledSessionEpoch ===
          next.notificationObservation.settledSessionEpoch &&
        !hasUnsettledCurrentRunWork(previous, previousById) &&
        isCompletedThreadStatusFromThread(previous))
    ) {
      continue;
    }

    candidates.push({
      threadId: next.id,
      projectId: next.projectId,
      title: next.title,
      completedAt: nextTurn.completedAt,
      assistantSummary:
        next.notificationObservation?.messages.findLast(
          (message) => message.turnId === nextTurn.turnId && message.completedAt,
        )?.text || summarizeLatestAssistantMessage(next),
      kind: "completed",
      notificationKey: `completed:${next.id}:${next.notificationObservation.settledSessionEpoch}:${nextTurn.turnId}`,
      messageId: nextTurn.assistantMessageId ?? undefined,
    });
  }

  return candidates;
}

export function collectAgentUpdateCandidates(
  previousThreads: Thread[],
  nextThreads: Thread[],
): CompletedThreadCandidate[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread]));
  return nextThreads.flatMap((thread) => {
    const previous = previousById.get(thread.id);
    if (!previous || !isVisibleThread(thread)) return [];
    const seen = new Set(
      previous.notificationObservation?.messages
        .filter((message) => message.completedAt)
        .map((message) => message.messageId),
    );
    return (thread.notificationObservation?.messages ?? []).flatMap((message) =>
      !message.completedAt || seen.has(message.messageId)
        ? []
        : [
            {
              threadId: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              completedAt: message.completedAt,
              assistantSummary: message.text || null,
              kind: "update" as const,
              notificationKey: `update:${thread.id}:${message.messageId}`,
              messageId: message.messageId,
            },
          ],
    );
  });
}

/** Builds truthful copy for either a progress update or native task settlement. */
export function buildTaskCompletionCopy(candidate: CompletedThreadCandidate): {
  title: string;
  body: string;
} {
  const body = candidate.assistantSummary
    ? `${candidate.title}: ${candidate.assistantSummary}`
    : candidate.title;

  return { title: candidate.kind === "update" ? "Agent update" : "Task completed", body };
}
