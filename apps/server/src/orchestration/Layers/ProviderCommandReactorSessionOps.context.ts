import type { ChatAttachment, OrchestrationThread, ProviderSession } from "@bigbud/contracts";

/**
 * Whether the provider context must be rebuilt from the bigbud transcript. Attachments do not
 * prevent the rebuild: they are forwarded to the provider separately (plan D14).
 */
export function shouldRebuildProviderContextFromTranscript(input: {
  readonly thread: OrchestrationThread;
  readonly bootstrapThread: OrchestrationThread | null;
  readonly activeSession: ProviderSession | undefined;
  readonly messageText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): boolean {
  if (input.bootstrapThread) {
    return input.bootstrapThread.messages.length > 0;
  }
  if (input.activeSession) {
    return false;
  }
  return input.thread.messages.length > 1;
}
