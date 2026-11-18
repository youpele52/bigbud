import {
  ApprovalRequestId,
  CommandId,
  EventId,
  type ThreadId,
} from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts";

const at = "2026-11-10T12:00:00.000Z";

/**
 * A provider question activity on `threadId` with Allow and Deny options. `user-input.resolved`
 * is the provider's own report, which never counts as the user's answer.
 */
export const askQuestion = (
  threadId: ThreadId,
  requestId: string,
  question: string,
  kind: string,
) =>
  ({
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe(`provider:activity:${requestId}:${kind}`),
    threadId,
    activity: {
      id: EventId.makeUnsafe(`activity-${requestId}-${kind}`),
      tone: "info",
      kind,
      summary: kind,
      payload:
        kind === "user-input.requested"
          ? {
              requestId,
              questions: [
                {
                  id: question,
                  header: "Confirm",
                  question,
                  options: [
                    { label: "Allow", description: "Allow it" },
                    { label: "Deny", description: "Deny it" },
                  ],
                },
              ],
            }
          : { requestId, answers: { [question]: "Allow" } },
      turnId: null,
      createdAt: at,
    },
    createdAt: at,
  }) as OrchestrationCommand;

/** The user's answer from bigbud's question panel (a client command). */
export const respond = (threadId: ThreadId, requestId: string, answers: Record<string, unknown>) =>
  ({
    type: "thread.user-input.respond",
    commandId: CommandId.makeUnsafe(`client-respond-${requestId}`),
    threadId,
    requestId: ApprovalRequestId.makeUnsafe(requestId),
    answers,
    createdAt: at,
  }) as OrchestrationCommand;
