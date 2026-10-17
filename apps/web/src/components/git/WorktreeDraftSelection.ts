import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { DraftThreadState } from "../../stores/composer/types.store";
import {
  readOwnershipLedger,
  registerDraftOwnership,
} from "../../stores/ownership/ownershipLedger";
import { reconcileComposerFromOwnershipLedger } from "../../stores/ownership/ownershipLedger.reconcile";
import { readMaterializationLedger } from "../../stores/materialization/materializationLedger";

/** Save a verified selection in ownership as well as composer storage, so reconnect cannot revive old cwd. */
export async function persistWorktreeDraftSelection(
  threadId: ThreadId,
  previous: DraftThreadState,
  next: DraftThreadState,
): Promise<void> {
  const sends = readMaterializationLedger();
  if (sends.status !== "ready" || sends.value.attemptsByThreadId[threadId])
    throw new Error(
      "This draft has an unconfirmed send. Wait for ownership to reconcile before switching worktrees.",
    );
  const ledger = readOwnershipLedger();
  if (ledger.status !== "ready")
    throw new Error("Draft ownership storage is unavailable. Reconnect before switching.");
  const owner = ledger.value.scopes.main?.draftsByThreadId[threadId];
  if (!owner) throw new Error("Draft owner changed. Reopen this chat before switching.");
  await registerDraftOwnership({
    scope: "main",
    threadId,
    draft: next,
    bindProject: true,
    expectedGeneration: owner.generation,
    expectedWorktreePath: { value: previous.worktreePath },
  });
  reconcileComposerFromOwnershipLedger();
}
