import type { CommandId, MessageId, NativeApi, ProjectId, ThreadId } from "@bigbud/contracts";

import { createOwnershipReplacementThreadId } from "../../../hooks/useHandleNewThread.ownership";
import {
  clearPromotedDraftThread,
  replaceCollidingDraftThreadLocally,
  useComposerDraftStore,
} from "../../../stores/composer";
import {
  setMaterializationAttemptStatus,
  type MaterializationAttempt,
} from "../../../stores/materialization/materializationLedger";
import { toastManager } from "../../ui/toast";
import {
  prepareDraftMaterialization,
  resolveFailedMaterialization,
} from "./ChatView.materializationAttempt";
import { repairDuplicateCreateDraft } from "./ChatView.sendTurn.ownership";

interface MaterializationInput {
  readonly api: Pick<NativeApi, "orchestration">;
  readonly isDraft: boolean;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly kind: "turn" | "shell";
  readonly createdAt: string;
  readonly requestDigest: string;
  readonly setThreadError: (threadId: ThreadId, error: string | null) => void;
  readonly onThreadMaterialized?: ((threadId: ThreadId) => Promise<void> | void) | undefined;
}

export type MaterializationSendGate =
  | { readonly proceed: true; readonly attempt: MaterializationAttempt | null }
  | { readonly proceed: false };

async function reconcileAcceptedAttempt(
  input: Pick<MaterializationInput, "threadId" | "onThreadMaterialized">,
): Promise<void> {
  await input.onThreadMaterialized?.(input.threadId);
}

export async function prepareMaterializationForSend(
  input: MaterializationInput,
): Promise<MaterializationSendGate> {
  const result = await prepareDraftMaterialization({
    ...input,
    trackExistingThread: !input.isDraft,
  });
  if (result.status === "blocked") {
    input.setThreadError(input.threadId, result.reason);
    return { proceed: false };
  }
  if (result.status === "already-accepted") {
    await reconcileAcceptedAttempt(input);
    toastManager.add({
      type: "info",
      title: "Your message was sent",
      description: "bigbud confirmed the earlier send and synchronized this chat.",
    });
    return { proceed: false };
  }
  if (result.status === "ready") return { proceed: true, attempt: result.attempt };
  if (result.ownership.status === "active" && input.isDraft) {
    clearPromotedDraftThread(input.threadId);
    await input.onThreadMaterialized?.(input.threadId);
    input.setThreadError(input.threadId, "This chat already exists and has been synchronized.");
    return { proceed: false };
  }

  const draft = useComposerDraftStore.getState().getDraftThread(input.threadId);
  if (draft) {
    const nextThreadId = await createOwnershipReplacementThreadId(result.ownership);
    replaceCollidingDraftThreadLocally({
      threadId: input.threadId,
      nextThreadId,
      projectId: draft.projectId,
      createdAt: new Date().toISOString(),
    });
    toastManager.add({
      type: "info",
      title: "Saved draft moved to a fresh chat",
      description: "That thread ID already belongs to the server. Your draft is safe to send.",
    });
  }
  return { proceed: false };
}

export async function markMaterializationDispatching(
  attempt: MaterializationAttempt | null,
): Promise<void> {
  if (attempt) {
    await setMaterializationAttemptStatus(attempt.threadId, attempt.generation, "dispatching");
  }
}

export async function completeMaterialization(
  input: Pick<MaterializationInput, "threadId" | "onThreadMaterialized">,
  attempt: MaterializationAttempt | null,
  acceptedSequence: number,
): Promise<void> {
  if (!attempt) return;
  await setMaterializationAttemptStatus(
    attempt.threadId,
    attempt.generation,
    "accepted-awaiting-event",
    acceptedSequence,
  );
  await input.onThreadMaterialized?.(input.threadId);
}

export async function classifyMaterializationFailure(
  api: Pick<NativeApi, "orchestration">,
  attempt: MaterializationAttempt | null,
): Promise<"not-materializing" | "accepted" | "rejected" | "ambiguous"> {
  return attempt ? resolveFailedMaterialization({ api, attempt }) : "not-materializing";
}

export async function reconcileAcceptedMaterializationFailure(
  input: Pick<MaterializationInput, "threadId" | "onThreadMaterialized">,
  _attempt: MaterializationAttempt,
  kind: "message" | "command",
): Promise<void> {
  await reconcileAcceptedAttempt(input);
  toastManager.add({
    type: "info",
    title: `Your ${kind} was sent`,
    description: "bigbud confirmed the send after reconnecting.",
  });
}

export async function repairRejectedMaterializationDraft(input: {
  readonly api: Pick<NativeApi, "orchestration">;
  readonly error: unknown;
  readonly threadId: ThreadId;
  readonly contentKind: "prompt" | "command";
}): Promise<void> {
  const replacementThreadId = await repairDuplicateCreateDraft({
    api: input.api,
    error: input.error,
    threadId: input.threadId,
    getDraft: (threadId) => useComposerDraftStore.getState().getDraftThread(threadId),
    replaceCollision: (replacement) => replaceCollidingDraftThreadLocally(replacement),
  });
  if (!replacementThreadId) return;
  toastManager.add({
    type: "info",
    title: "Saved draft moved to a fresh chat",
    description: `That thread ID already belongs to the server. Your ${input.contentKind} is safe to resend.`,
  });
}
