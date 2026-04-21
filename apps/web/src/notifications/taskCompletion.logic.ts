import type { Thread } from "../models/types";

export interface CompletedThreadCandidate {
  threadId: string;
  projectId: string;
  title: string;
  completedAt: string;
  assistantSummary: string | null;
}

const ASSISTANT_SUMMARY_MAX_LENGTH = 140;

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
 *   - The previous latestTurn.state was "running" (or the turn was absent).
 *   - The next latestTurn.state is "completed".
 *   - The next latestTurn.completedAt is non-null and differs from the previous.
 */
export function collectCompletedThreadCandidates(
  previousThreads: Thread[],
  nextThreads: Thread[],
): CompletedThreadCandidate[] {
  const previousById = new Map(previousThreads.map((t) => [t.id, t]));
  const candidates: CompletedThreadCandidate[] = [];

  for (const next of nextThreads) {
    const nextTurn = next.latestTurn;
    if (!nextTurn || nextTurn.state !== "completed" || !nextTurn.completedAt) {
      continue;
    }

    const previous = previousById.get(next.id);
    const previousTurn = previous?.latestTurn ?? null;

    // Skip if the completedAt hasn't changed — this avoids re-firing on re-renders.
    if (previousTurn?.completedAt === nextTurn.completedAt) {
      continue;
    }

    // Only fire when transitioning from a running/pending state.
    const wasRunning =
      previousTurn === null ||
      previousTurn.state === "running" ||
      previousTurn.completedAt !== nextTurn.completedAt;

    if (!wasRunning) {
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
