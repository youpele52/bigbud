import { type ModelSelection, type NativeApi, type ThreadId } from "@bigbud/contracts";
import { DEFAULT_THREAD_TITLE } from "@bigbud/shared/String";
import { useComposerDraftStore, clearPromotedDraftThread } from "../stores/composer";
import { useStore } from "../stores/main";
import { getDefaultModelSelection } from "../models/provider/provider.models";
import { getServerConfig } from "../rpc/serverState";
import { readNativeApi } from "../rpc/nativeApi";
import { buildExplicitExecutionTargets } from "./providerExecutionTargets";
import { dispatchCommandWithOutcomeRecovery } from "./orchestrationCommandRecovery.dispatch";
import { readMaterializationLedger } from "../stores/materialization/materializationLedger";
import { preservePendingEnvMode } from "./threadMaterialization.envMode";
import { runBoundedBootstrap } from "../routes/-__root.bounded-bootstrap";
import { resolveOwnerCreationCommand } from "./threadMaterialization.command";
import {
  markTerminalOwnerConfirmed,
  pendingThreadCreations,
} from "./threadMaterialization.admission";

async function materializeOwner(
  threadId: ThreadId,
  api: NativeApi,
  modelSelection?: ModelSelection,
): Promise<boolean> {
  const composer = useComposerDraftStore.getState();
  const draft = composer.getDraftThread(threadId);
  // Persisted chats may be unloaded from the bounded client catalog; server leases enforce ownership.
  if (!draft) return false;
  const project = useStore.getState().projects.find((item) => item.id === draft.projectId);
  if (!project) throw new Error("The chat's creation project is unavailable. Reopen it and retry.");
  const ledger = readMaterializationLedger();
  if (ledger.status === "unavailable")
    throw new Error("Saved send state is unavailable. Reconnect before saving this chat.");
  const previousSend = ledger.value.attemptsByThreadId[threadId];
  let acceptedPreviousSend = false;
  if (previousSend && !previousSend.requiresOutcome) {
    const outcome = await api.orchestration.getCommandOutcome({
      commandId: previousSend.commandId,
    });
    if (outcome.status === "unknown")
      throw new Error(
        "The previous send is still being checked. Retry after reconnecting; your draft is safe.",
      );
    acceptedPreviousSend =
      outcome.status === "accepted" &&
      outcome.aggregateKind === "thread" &&
      outcome.aggregateId === threadId;
  }
  const ownership = await api.orchestration.resolveThreadOwnership({ threadId });
  if (ownership.status === "unavailable") throw new Error(ownership.reason);
  const { commandId, outcome: creationOutcome } = await resolveOwnerCreationCommand(api, threadId);
  if (ownership.status !== "absent") {
    if (ownership.status !== "active")
      throw new Error("This chat was removed. Start a new chat before opening a terminal.");
    if (creationOutcome.status !== "accepted" && !acceptedPreviousSend)
      throw new Error(
        "This draft ID already belongs to another saved chat. Reopen the chat to reconcile ownership.",
      );
  } else {
    if (creationOutcome.status === "accepted")
      throw new Error(
        "The saved chat is no longer available on this server. Reopen the chat to reconcile ownership.",
      );
    preservePendingEnvMode(threadId, draft.envMode);
    const settings = composer.draftsByThreadId[threadId];
    const selection =
      modelSelection ??
      (settings?.activeProvider
        ? settings.modelSelectionByProvider[settings.activeProvider]
        : undefined) ??
      project.defaultModelSelection ??
      getDefaultModelSelection(getServerConfig()?.providers ?? []);
    await dispatchCommandWithOutcomeRecovery(api, {
      type: "thread.create",
      commandId,
      threadId,
      projectId: draft.projectId,
      title: DEFAULT_THREAD_TITLE,
      ...buildExplicitExecutionTargets({
        workspaceExecutionTargetId: project.workspaceExecutionTargetId ?? project.executionTargetId,
        providerRuntimeExecutionTargetId: project.providerRuntimeExecutionTargetId,
      }),
      modelSelection: selection,
      runtimeMode: settings?.runtimeMode ?? draft.runtimeMode,
      interactionMode: settings?.interactionMode ?? draft.interactionMode,
      branch: draft.branch,
      worktreePath: draft.worktreePath,
      ...(draft.worktreeBinding ? { worktreeBinding: draft.worktreeBinding } : {}),
      createdAt: draft.createdAt,
    });
  }
  // Reuse normal bounded, event-buffered synchronization when creation's event is delayed.
  if (!useStore.getState().threads.some((thread) => thread.id === threadId)) {
    await runBoundedBootstrap({ api, selectedThreadId: threadId, disposed: () => false });
  }
  if (!useStore.getState().threads.some((thread) => thread.id === threadId)) {
    throw new Error("The saved chat could not be synchronized. Reconnect and retry.");
  }
  clearPromotedDraftThread(threadId);
  return true;
}

/** Both terminal surfaces and first send share the same normal, zero-message durable owner. */
export function ensureThreadMaterialized(
  threadId: ThreadId,
  modelSelection?: ModelSelection,
): Promise<void> {
  const pending = pendingThreadCreations.get(threadId);
  if (pending) return pending;
  const api = readNativeApi();
  if (!api) return Promise.reject(new Error("bigbud is not connected to the server."));
  const operation = materializeOwner(threadId, api, modelSelection).then((confirmed) => {
    if (confirmed) markTerminalOwnerConfirmed(threadId);
  });
  pendingThreadCreations.set(threadId, operation);
  void operation
    .finally(() => {
      if (pendingThreadCreations.get(threadId) === operation)
        pendingThreadCreations.delete(threadId);
    })
    .catch(() => undefined);
  return operation;
}
