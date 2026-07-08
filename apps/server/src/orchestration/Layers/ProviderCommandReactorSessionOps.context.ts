import type { ChatAttachment, OrchestrationThread, ProviderSession } from "@bigbud/contracts";
import { hasAnyAttachments } from "@bigbud/shared/history";

export function shouldRebuildProviderContextFromTranscript(input: {
  readonly thread: OrchestrationThread;
  readonly bootstrapThread: OrchestrationThread | null;
  readonly activeSession: ProviderSession | undefined;
  readonly messageText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): boolean {
  if (input.bootstrapThread) {
    return input.bootstrapThread.messages.length > 0 && !hasAnyAttachments(input.attachments);
  }
  if (input.activeSession) {
    return false;
  }
  if (input.thread.messages.length <= 1) {
    return false;
  }
  if (hasAnyAttachments(input.attachments)) {
    return false;
  }
  return true;
}
