import type { OrchestrationCommand, OrchestrationThread } from "@bigbud/contracts";
import { providerAttachmentIssue } from "@bigbud/shared/providerAttachments";
import { Effect } from "effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** Validate original attachment intent before queuing, reference expansion or durable turn events. */
export function requireThreadAttachmentsSupported(
  thread: OrchestrationThread,
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" | "thread.message.submit" }>,
) {
  const attachments = command.message.attachments;
  const issue =
    providerAttachmentIssue(
      thread.session?.providerName ?? thread.modelSelection.provider,
      attachments,
    ) ?? providerAttachmentIssue(command.modelSelection?.provider, attachments);
  return issue
    ? Effect.fail(
        new OrchestrationCommandInvariantError({ commandType: command.type, detail: issue }),
      )
    : Effect.void;
}
