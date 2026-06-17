import type { Thread } from "../models/types";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  findLatestProposedPlan,
  hasActionableProposedPlan,
} from "../logic/session";
import { isThreadCompletedStatus } from "../logic/thread/threadCompletion.logic";

export interface CompletedThreadCandidate {
  threadId: string;
  projectId: string;
  title: string;
  completedAt: string;
  assistantSummary: string | null;
}

const ASSISTANT_SUMMARY_MAX_LENGTH = 140;

function isCompletedThreadStatusFromThread(thread: Thread): boolean {
  return isThreadCompletedStatus({
    interactionMode: thread.interactionMode,
    latestTurn: thread.latestTurn,
    session: thread.session,
    hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
    hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
    hasActionableProposedPlan: hasActionableProposedPlan(
      findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
    ),
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
    if (message && message.role === "assistant") {
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
 *   - The thread exists in both snapshots.
 *   - The next thread has entered the same "Completed" state used by the sidebar.
 *   - The previous thread was not already in that state.
 */
export function collectCompletedThreadCandidates(
  previousThreads: Thread[],
  nextThreads: Thread[],
): CompletedThreadCandidate[] {
  const previousById = new Map(previousThreads.map((t) => [t.id, t]));
  const candidates: CompletedThreadCandidate[] = [];

  for (const next of nextThreads) {
    const nextTurn = next.latestTurn;
    if (!nextTurn?.completedAt) {
      continue;
    }

    const previous = previousById.get(next.id);
    if (!previous) {
      continue;
    }

    if (!isCompletedThreadStatusFromThread(next) || isCompletedThreadStatusFromThread(previous)) {
      continue;
    }

    candidates.push({
      threadId: next.id,
      projectId: next.projectId,
      title: next.title,
      completedAt: nextTurn.completedAt,
      assistantSummary: summarizeLatestAssistantMessage(next),
    });
  }

  return candidates;
}

/** Builds the title and body copy for a task completion notification. */
export function buildTaskCompletionCopy(candidate: CompletedThreadCandidate): {
  title: string;
  body: string;
} {
  const body = candidate.assistantSummary
    ? `${candidate.title}: ${candidate.assistantSummary}`
    : candidate.title;

  return { title: "Task completed", body };
}
