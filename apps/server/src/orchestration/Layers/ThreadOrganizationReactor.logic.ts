import type { OrchestrationEvent, ThreadId } from "@bigbud/contracts";
import { DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice.ts";
import type {
  ThreadOrganization,
  ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";

export interface ThreadOrganizationReaction {
  readonly threadId: ThreadId;
  readonly state: ThreadOrganizationState;
  /** Identifies the fact that caused the move, so a repeated fact never moves twice. */
  readonly key: string;
}

/** Activities that block on the user: approvals, questions, and delegated model choices. */
const BLOCKING_ACTIVITY_KINDS = new Set<string>([
  "approval.requested",
  "user-input.requested",
  DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND,
]);

const requestIdOf = (payload: unknown): string | null => {
  const requestId = (payload as { requestId?: unknown } | null)?.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
};

type MessageSentPayload = Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"];

/** Only the user's own words count as human work; agent, automation, or recovery text does not. */
const isUserAuthored = (originSegments: MessageSentPayload["originSegments"]) =>
  (originSegments ?? []).every((segment) => segment.actor === "user");

function isHumanMessage(payload: MessageSentPayload): boolean {
  if (payload.role !== "user" || payload.streaming || payload.replace === true) return false;
  return isUserAuthored(payload.originSegments);
}

/**
 * The organization move an accepted event implies, if any:
 * - a new approval or user-input request needs the user, so the thread moves to Needs you
 *   (cancelling an older snooze);
 * - the user's own response or new message is work, so the thread returns to Present.
 * Provider output alone never moves a thread, so it cannot undo an explicit Later or Done.
 */
export function organizationReactionForEvent(
  event: OrchestrationEvent,
): ThreadOrganizationReaction | null {
  switch (event.type) {
    case "thread.activity-appended": {
      const { activity, threadId } = event.payload;
      if (!BLOCKING_ACTIVITY_KINDS.has(activity.kind)) return null;
      // A request without an id is still keyed by its activity, which is unique per request.
      const requestId = requestIdOf(activity.payload) ?? activity.id;
      return { threadId, state: "needs-you", key: `attention:${activity.kind}:${requestId}` };
    }
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
      return {
        threadId: event.payload.threadId,
        state: "present",
        key: `response:${event.payload.requestId}`,
      };
    // A prompt queued behind a pending request is still the user's work. It shares its key with
    // the message sent when the queue flushes, so the flush never undoes a later move.
    case "thread.prompt-queued": {
      const { prompt, threadId } = event.payload;
      return prompt.alreadySent !== true && isUserAuthored(prompt.originSegments)
        ? { threadId, state: "present", key: `message:${prompt.id}` }
        : null;
    }
    case "thread.message-sent":
      return isHumanMessage(event.payload)
        ? {
            threadId: event.payload.threadId,
            state: "present",
            key: `message:${event.payload.messageId}`,
          }
        : null;
    default:
      return null;
  }
}

/** A reaction is redundant when the thread already rests in that state with no snooze pending. */
export function isOrganizationReactionNeeded(
  current: ThreadOrganization,
  reaction: Pick<ThreadOrganizationReaction, "state">,
): boolean {
  return current.state !== reaction.state || current.snooze !== null;
}
