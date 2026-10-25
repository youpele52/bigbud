/**
 * Which prompt suggestion (Phase 7) the composer may show. Only the newest suggestion, and only
 * while it belongs to the latest settled turn: a new turn, a send, a queued prompt or a revert
 * (which drops the activity) clears it. Showing it never sends anything.
 *
 * @module promptSuggestion.logic
 */
import type { TurnId } from "@bigbud/contracts";
import type { PromptSuggestionActivityPayload } from "@bigbud/contracts/orchestration/orchestration.promptSuggestion";
import { readPromptSuggestionActivity } from "@bigbud/shared/promptSuggestion";

import type { Thread } from "~/models/types/app.types";

export interface VisiblePromptSuggestion extends PromptSuggestionActivityPayload {
  readonly turnId: TurnId;
}

type SuggestionThread = Pick<
  Thread,
  "latestTurn" | "session" | "queuedPrompts" | "archivedAt" | "messages" | "activities"
>;

function isSettled(thread: SuggestionThread): boolean {
  const latest = thread.latestTurn;
  if (!latest || latest.state === "error" || latest.state === "interrupted") return false;
  const session = thread.session;
  if (
    session &&
    (session.activeTurnId !== undefined || session.orchestrationStatus === "running")
  ) {
    return false;
  }
  if ((thread.queuedPrompts ?? []).length > 0 || thread.archivedAt !== null) return false;
  return thread.messages.at(-1)?.role !== "user";
}

export function deriveVisiblePromptSuggestion(
  thread: SuggestionThread,
  enabled: boolean,
): VisiblePromptSuggestion | null {
  if (!enabled || !isSettled(thread)) return null;
  const newest = thread.activities.findLast((activity) => activity.kind === "prompt.suggestion");
  if (!newest || newest.turnId === null || newest.turnId !== thread.latestTurn?.turnId) return null;
  const payload = readPromptSuggestionActivity(newest);
  return payload ? { ...payload, turnId: newest.turnId } : null;
}
