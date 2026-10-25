/**
 * Server-side prompt suggestion rules (Phase 7), shared by ingestion (native suggestions) and
 * the generated-suggestion reactor. A suggestion attaches only to the thread's latest settled
 * turn; anything newer (a send, a queued prompt, a new turn) clears it.
 *
 * @module promptSuggestion.logic
 */
import type {
  EventId,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProviderKind,
  TurnId,
} from "@bigbud/contracts";
import {
  PROMPT_SUGGESTION_ACTIVITY_KIND,
  type PromptSuggestionSource,
} from "@bigbud/contracts/orchestration/orchestration.promptSuggestion";
import { normalizePromptSuggestion } from "@bigbud/shared/promptSuggestion";

export type PromptSuggestionThread = Pick<
  OrchestrationThread,
  | "latestTurn"
  | "session"
  | "queuedPrompts"
  | "archivedAt"
  | "deletingAt"
  | "deletedAt"
  | "messages"
>;

/** The text of the newest user message, if any. */
export function lastUserMessageText(
  messages: PromptSuggestionThread["messages"],
): string | undefined {
  return messages.findLast((message) => message.role === "user")?.text;
}

/**
 * `turnId` is the latest turn, it ended without an error or interruption, no turn is running,
 * nothing is queued, the newest message is not a newer user message, and the thread is live.
 * A turn whose checkpoint is still being captured (`running` with an idle session) counts.
 */
export function isPromptSuggestionAttachable(
  thread: PromptSuggestionThread,
  turnId: TurnId | null | undefined,
): boolean {
  const latest = thread.latestTurn;
  if (!turnId || latest?.turnId !== turnId) return false;
  if (latest.state === "error" || latest.state === "interrupted") return false;
  const session = thread.session;
  if (session && (session.activeTurnId !== null || session.status === "running")) return false;
  if (session?.status === "error") return false;
  if ((thread.queuedPrompts ?? []).length > 0) return false;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    (thread.deletingAt ?? null) !== null
  ) {
    return false;
  }
  return thread.messages.at(-1)?.role !== "user";
}

/** A normalized `prompt.suggestion` activity, or `null` when it must not attach. */
export function buildPromptSuggestionActivity(input: {
  readonly thread: PromptSuggestionThread;
  readonly turnId: TurnId | null | undefined;
  readonly raw: string;
  readonly source: PromptSuggestionSource;
  readonly provider: ProviderKind;
  readonly eventId: EventId;
  readonly createdAt: string;
}): OrchestrationThreadActivity | null {
  if (!input.turnId || !isPromptSuggestionAttachable(input.thread, input.turnId)) return null;
  const suggestion = normalizePromptSuggestion(input.raw, {
    lastUserMessage: lastUserMessageText(input.thread.messages),
  });
  if (suggestion === null) return null;
  return {
    id: input.eventId,
    createdAt: input.createdAt,
    tone: "info",
    kind: PROMPT_SUGGESTION_ACTIVITY_KIND,
    summary: "Suggested next prompt",
    payload: { suggestion, source: input.source, provider: input.provider },
    turnId: input.turnId,
  };
}
