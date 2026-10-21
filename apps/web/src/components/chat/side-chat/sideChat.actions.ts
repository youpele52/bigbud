import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type OrchestrationEvent,
  type ThreadId,
} from "@bigbud/contracts";

import { type Thread } from "../../../models/types";
import { newCommandId, newThreadId, randomUUID } from "~/lib/utils";
import { dispatchCommandWithOutcomeRecovery } from "~/lib/orchestrationCommandRecovery";
import { readNativeApi } from "~/rpc/nativeApi";
import { type RemovedComposerThreadReferenceFiles, useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import { isSideChatClosing, useSideChatStore } from "~/stores/sideChat";
import { toastManager } from "~/components/ui/toast";
import { getDeletedThreadIds } from "~/logic/orchestration/thread-deletion.logic";

const detachedReferencesBySidecarId = new Map<ThreadId, RemovedComposerThreadReferenceFiles[]>();

function detachSidecarReferences(threadId: ThreadId): void {
  if (detachedReferencesBySidecarId.has(threadId)) {
    return;
  }
  detachedReferencesBySidecarId.set(
    threadId,
    useComposerDraftStore.getState().removeThreadReferenceFiles(threadId),
  );
}

function restoreDetachedSidecarReferences(threadId: ThreadId): void {
  const references = detachedReferencesBySidecarId.get(threadId) ?? [];
  detachedReferencesBySidecarId.delete(threadId);
  const composerStore = useComposerDraftStore.getState();
  for (const reference of references) {
    composerStore.addFiles(reference.draftThreadId, reference.files);
  }
}

export function attachSidecarToComposer(input: {
  mainThreadId: ThreadId;
  sidecarThreadId: ThreadId;
}): boolean {
  if (input.mainThreadId === input.sidecarThreadId) {
    return false;
  }

  const threads = useStore.getState().threads;
  const sidecarThread = threads.find(
    (thread) =>
      thread.id === input.sidecarThreadId &&
      thread.purpose === "side-chat" &&
      thread.deletingAt == null,
  );
  if (!sidecarThread || sidecarThread.messages.length === 0) {
    return false;
  }

  const composerStore = useComposerDraftStore.getState();
  const mainServerThread = threads.find((thread) => thread.id === input.mainThreadId);
  const mainDraftThread = composerStore.getDraftThread(input.mainThreadId);
  if (
    (!mainServerThread && !mainDraftThread) ||
    mainServerThread?.purpose === "side-chat" ||
    mainServerThread?.deletingAt != null
  ) {
    return false;
  }

  const draft = composerStore.draftsByThreadId[input.mainThreadId];
  if (
    draft?.files.some(
      (file) =>
        file.attachmentMode === "thread-reference" && file.threadId === input.sidecarThreadId,
    )
  ) {
    return false;
  }

  const attachmentCount = (draft?.images.length ?? 0) + (draft?.files.length ?? 0);
  if (attachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    toastManager.add({
      type: "error",
      title: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    });
    return false;
  }

  composerStore.addFile(input.mainThreadId, {
    type: "file",
    id: randomUUID(),
    name: sidecarThread.title,
    mimeType: "application/x-bigbud-thread-reference",
    sizeBytes: 0,
    attachmentMode: "thread-reference",
    filePath: "",
    file: null,
    threadId: sidecarThread.id,
    threadTitle: sidecarThread.title,
    watchForCompletion: false,
  });
  return true;
}

export async function openSideChat(activeThread: Thread): Promise<void> {
  const sideChat = useSideChatStore.getState();
  if (sideChat.threadId) {
    if (sideChat.presentation === "creating") {
      return;
    }
    sideChat.restore();
    return;
  }

  const existing = useStore
    .getState()
    .threads.find(
      (thread) =>
        thread.purpose === "side-chat" &&
        thread.deletingAt === null &&
        thread.id !== sideChat.closedThreadId &&
        !isSideChatClosing(sideChat, thread.id),
    );
  if (existing) {
    useSideChatStore.getState().show(existing.id);
    return;
  }

  const api = readNativeApi();
  if (!api) return;

  const threadId = newThreadId();
  useSideChatStore.getState().beginCreate(threadId);
  try {
    await dispatchCommandWithOutcomeRecovery(api, {
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: activeThread.projectId,
      title: "Sidecar",
      purpose: "side-chat",
      providerRuntimeExecutionTargetId: activeThread.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId: activeThread.workspaceExecutionTargetId,
      executionTargetId: activeThread.executionTargetId,
      modelSelection: activeThread.modelSelection,
      runtimeMode: activeThread.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    useSideChatStore.getState().failCreate(threadId);
    toastManager.add({
      type: "error",
      title: "Could not open Sidecar",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

export async function toggleSideChat(activeThread: Thread): Promise<void> {
  const sideChat = useSideChatStore.getState();
  if (!sideChat.threadId) {
    return openSideChat(activeThread);
  }
  if (sideChat.presentation === "creating") {
    return;
  }
  if (sideChat.presentation === "open") {
    sideChat.minimize();
    return;
  }
  sideChat.restore();
}

export async function closeSideChat(threadId: Thread["id"]): Promise<void> {
  if (isSideChatClosing(useSideChatStore.getState(), threadId)) {
    return;
  }
  const api = readNativeApi();
  useSideChatStore.getState().beginClose(threadId, new Date().toISOString());
  detachSidecarReferences(threadId);
  if (!api) {
    restoreSideChatAfterDeletionFailure(threadId);
    return;
  }

  try {
    await dispatchCommandWithOutcomeRecovery(api, {
      type: "thread.delete",
      commandId: newCommandId(),
      threadId,
    });
  } catch (error) {
    restoreSideChatAfterDeletionFailure(
      threadId,
      error instanceof Error ? error.message : "An error occurred.",
    );
  }
}

export function completeSideChatClose(threadId: ThreadId): void {
  const composerStore = useComposerDraftStore.getState();
  const detachedReferences =
    detachedReferencesBySidecarId.get(threadId) ??
    composerStore.removeThreadReferenceFiles(threadId);
  const removedReferenceCount = detachedReferences.reduce(
    (count, reference) => count + reference.files.length,
    0,
  );
  detachedReferencesBySidecarId.delete(threadId);
  composerStore.clearDraftThread(threadId);
  useSideChatStore.getState().completeClose(threadId);
  if (removedReferenceCount > 0) {
    toastManager.add({
      type: "info",
      title: "Removed Sidecar context",
      description: "Sidecar was removed from unsent composer attachments.",
    });
  }
}

export function restoreSideChatAfterDeletionFailure(
  threadId: ThreadId,
  description = "The Sidecar deletion did not complete.",
): void {
  if (!isSideChatClosing(useSideChatStore.getState(), threadId)) {
    return;
  }
  restoreDetachedSidecarReferences(threadId);
  useSideChatStore.getState().failClose(threadId);
  toastManager.add({
    type: "error",
    title: "Could not close Sidecar",
    description,
  });
}

export function applySideChatLifecycleEvents(events: ReadonlyArray<OrchestrationEvent>): void {
  for (const event of events) {
    const state = useSideChatStore.getState();
    switch (event.type) {
      case "thread.created":
        if (event.payload.threadId === state.threadId && event.payload.purpose === "side-chat") {
          state.completeCreate(event.payload.threadId);
        }
        break;
      case "thread.deletion-requested":
        state.markDeletionRequested(event.payload.threadId);
        break;
      case "thread.deletion-failed":
        restoreSideChatAfterDeletionFailure(event.payload.threadId);
        break;
      case "thread.deleted":
        for (const threadId of getDeletedThreadIds(event.payload)) {
          if (isSideChatClosing(useSideChatStore.getState(), threadId)) {
            completeSideChatClose(threadId);
          }
        }
        break;
      default:
        break;
    }
  }
}

function reconcileClosingSideChat(
  threadId: ThreadId,
  thread: Thread | undefined,
  startedAt: string,
): void {
  if (!thread) {
    completeSideChatClose(threadId);
    return;
  }
  if (thread.deletingAt != null) {
    useSideChatStore.getState().markDeletionRequested(threadId);
    return;
  }
  const hasCurrentDeletionFailure = thread.activities.some(
    (activity) => activity.kind === "thread.delete.failed" && activity.createdAt >= startedAt,
  );
  const deletionRequested = useSideChatStore.getState().closingThreads[threadId]?.deletionRequested;
  if (deletionRequested || hasCurrentDeletionFailure) {
    restoreSideChatAfterDeletionFailure(threadId);
  }
}

export function reconcileSideChatSnapshot(threads: ReadonlyArray<Thread>): void {
  const findThread = (threadId: ThreadId) => threads.find((entry) => entry.id === threadId);
  for (const [threadId, entry] of Object.entries(useSideChatStore.getState().closingThreads)) {
    reconcileClosingSideChat(
      threadId as ThreadId,
      findThread(threadId as ThreadId),
      entry.startedAt,
    );
  }

  const state = useSideChatStore.getState();
  if (!state.threadId) {
    return;
  }
  const thread = findThread(state.threadId);
  if (state.presentation === "creating") {
    if (thread?.purpose === "side-chat") {
      state.completeCreate(state.threadId);
    } else {
      state.failCreate(state.threadId);
    }
    return;
  }
  if (!thread) {
    state.clearMissing(state.threadId);
  }
}
