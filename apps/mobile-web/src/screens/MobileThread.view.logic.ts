import type { OrchestrationMessage } from "@bigbud/contracts";

interface MobileEmptyStateInput {
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "role">>;
  readonly workLogEntryCount: number;
  readonly hasWorkingIndicator: boolean;
  readonly isRunning: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasConnectionNotice: boolean;
}

export function shouldShowMobileEmptyState(input: MobileEmptyStateInput): boolean {
  const hasConversationMessage = input.messages.some(
    (message) => message.role === "user" || message.role === "assistant",
  );

  return (
    !hasConversationMessage &&
    input.workLogEntryCount === 0 &&
    !input.hasWorkingIndicator &&
    !input.isRunning &&
    !input.hasPendingApproval &&
    !input.hasPendingUserInput &&
    !input.hasConnectionNotice
  );
}
