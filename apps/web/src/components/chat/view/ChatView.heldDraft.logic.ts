import type { OrchestrationQueuedPrompt } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/rpc/nativeApi";
import { dispatchClaimedCommand } from "~/lib/orchestrationCommandRecovery";
import type { HeldClaim, HeldDraft, HeldRecovery } from "./ChatView.heldDraft.storage";

export function prepareHeldDraft(
  threadId: HeldClaim["threadId"],
  prompt: OrchestrationQueuedPrompt,
): HeldDraft {
  return {
    claim: {
      type: "thread.queued-prompt.claim",
      commandId: newCommandId(),
      threadId,
      messageId: prompt.id,
      promptCreatedAt: prompt.createdAt,
      alreadySent: prompt.alreadySent === true,
      createdAt: new Date().toISOString(),
    },
    prompt,
    claimed: false,
  };
}

export function buildHeldDraftRecovery(
  draft: HeldDraft,
  action: HeldRecovery["action"],
): HeldRecovery {
  return {
    type: "thread.queued-prompt.recovered",
    commandId: newCommandId(),
    threadId: draft.claim.threadId,
    claimId: draft.claim.commandId,
    action,
    createdAt: new Date().toISOString(),
  };
}

export async function dispatchHeldDraftCommand(command: HeldClaim | HeldRecovery): Promise<void> {
  const api = readNativeApi();
  if (!api) throw new Error("The app is not connected. Retry when it reconnects.");
  // IndexedDB holds the immutable attempt, not the small localStorage ledger.
  await dispatchClaimedCommand(api, command, { storage: null });
}
