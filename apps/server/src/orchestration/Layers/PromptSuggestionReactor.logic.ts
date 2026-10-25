/**
 * Pure rules for generated prompt suggestions (Phase 7): when to generate,
 * what context to send and which events cancel an in-flight generation.
 *
 * @module PromptSuggestionReactor.logic
 */
import type { OrchestrationEvent, OrchestrationThread, ThreadId, TurnId } from "@bigbud/contracts";
import { PROMPT_SUGGESTION_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/orchestration.promptSuggestion";
import { derivePendingDelegatedModelChoice } from "@bigbud/shared/delegatedModelChoice";
import { redactPromptSuggestionContext } from "@bigbud/shared/promptSuggestion";

import { isPromptSuggestionAttachable } from "../promptSuggestion.logic.ts";

export const PROMPT_SUGGESTION_TRANSCRIPT_MAX_CHARS = 6_000;
const PROMPT_SUGGESTION_MESSAGE_MAX_CHARS = 1_500;
const PROMPT_SUGGESTION_MAX_MESSAGES = 8;

export type GeneratedSuggestionSkipReason =
  | "not-attachable"
  | "first-turn"
  | "plan"
  | "pending-request"
  | "pending-model-choice"
  | "already-suggested";

function hasOpenRequest(thread: OrchestrationThread, turnId: TurnId): boolean {
  const open = new Set<string>();
  for (const activity of thread.activities) {
    if (activity.turnId !== turnId) continue;
    const requestId = (activity.payload as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== "string") continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      open.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      open.delete(requestId);
    }
  }
  return open.size > 0;
}

/** `null` when a generated suggestion may run for `turnId`, else why not. */
export function generatedSuggestionSkipReason(
  thread: OrchestrationThread,
  turnId: TurnId,
): GeneratedSuggestionSkipReason | null {
  if (!isPromptSuggestionAttachable(thread, turnId)) return "not-attachable";
  if (thread.latestTurn?.state !== "completed" && thread.latestTurn?.state !== "running") {
    return "not-attachable";
  }
  if (thread.messages.filter((message) => message.role === "user").length < 2) {
    return "first-turn";
  }
  if (thread.interactionMode === "plan") return "plan";
  if (hasOpenRequest(thread, turnId)) return "pending-request";
  if (derivePendingDelegatedModelChoice(thread.activities) !== null) {
    return "pending-model-choice";
  }
  if (
    thread.activities.some(
      (activity) => activity.kind === PROMPT_SUGGESTION_ACTIVITY_KIND && activity.turnId === turnId,
    )
  ) {
    return "already-suggested";
  }
  return null;
}

/** Recent user and assistant text only (no tool output or attachments), redacted and bounded. */
export function buildPromptSuggestionTranscript(messages: OrchestrationThread["messages"]): string {
  const sections: string[] = [];
  let length = 0;
  const visible = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  for (const message of visible.slice(-PROMPT_SUGGESTION_MAX_MESSAGES).toReversed()) {
    const text = redactPromptSuggestionContext(
      message.text.trim(),
      PROMPT_SUGGESTION_MESSAGE_MAX_CHARS,
    );
    if (text.length === 0) continue;
    const section = `${message.role === "user" ? "USER" : "ASSISTANT"}:\n${text}`;
    if (length + section.length + 2 > PROMPT_SUGGESTION_TRANSCRIPT_MAX_CHARS) break;
    sections.unshift(section);
    length += section.length + 2;
  }
  return sections.join("\n\n");
}

/** The thread whose in-flight generation an event cancels, if any. */
export function promptSuggestionCancelThreadId(event: OrchestrationEvent): ThreadId | null {
  switch (event.type) {
    case "thread.turn-start-requested":
    case "thread.prompt-queued":
    case "thread.reverted":
    case "thread.archived":
    case "thread.deletion-requested":
      return event.payload.threadId;
    case "thread.message-sent":
      return event.payload.role === "user" ? event.payload.threadId : null;
    default:
      return null;
  }
}
