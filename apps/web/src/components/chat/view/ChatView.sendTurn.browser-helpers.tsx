import { useRef } from "react";
import { vi, type Mock } from "vitest";
import { MessageId, type NativeApi, type ThreadId } from "@bigbud/contracts";
import { useOnSend } from "./ChatView.sendTurn.logic";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";
import { createProjectGateApi, recentId, otherId } from "./ThreadProjectGate.test-helpers";
import { runBoundedBootstrap } from "../../../routes/-__root.bounded-bootstrap";
import { useComposerDraftStore } from "../../../stores/composer";
import { useStore } from "../../../stores/main";
import { __resetNativeApiForTests } from "../../../rpc/nativeApi";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function installSendApi() {
  const fixture = createProjectGateApi();
  const dispatchCommand = vi.fn<NativeApi["orchestration"]["dispatchCommand"]>(async () => ({
    sequence: 11,
  }));
  const resolveThreadOwnership = vi.fn<NativeApi["orchestration"]["resolveThreadOwnership"]>(
    async ({ threadId }) => ({
      threadId,
      projectId: useStore.getState().threads.find((thread) => thread.id === threadId)!.projectId,
      status: "active",
      serverEpoch: "test-server",
      canonicalRevision: 10,
    }),
  );
  const getCommandOutcome = vi.fn<NativeApi["orchestration"]["getCommandOutcome"]>(
    async ({ commandId }) => ({
      commandId,
      status: "unknown",
      serverEpoch: "test-server",
      canonicalRevision: 10,
    }),
  );
  const api = {
    ...fixture.api,
    orchestration: {
      ...fixture.api.orchestration,
      dispatchCommand,
      resolveThreadOwnership,
      getCommandOutcome,
    },
  };
  window.nativeApi = api;
  __resetNativeApiForTests();
  await runBoundedBootstrap({ api, selectedThreadId: recentId, disposed: () => false });
  // Follow-ups, not new-thread creation; preserve actual hydrated store models.
  useStore.setState((state) => ({
    threads: state.threads.map((thread) => ({
      ...thread,
      messages: [
        {
          id: MessageId.makeUnsafe("earlier"),
          role: "user" as const,
          text: "Earlier",
          createdAt: thread.createdAt,
          streaming: false,
        },
      ],
    })),
  }));
  useComposerDraftStore.getState().setPrompt(recentId, "Original follow-up");
  useComposerDraftStore.getState().setPrompt(otherId, "Other thread draft");
  return { ...fixture, api, dispatchCommand, resolveThreadOwnership, getCommandOutcome };
}

interface SendControl {
  onSend: () => Promise<void>;
  input: UseOnSendInput | null;
  ui: { begin: Mock; reset: Mock; cursor: Mock; optimistic: Mock };
}

export function createSendControl(): SendControl {
  return {
    onSend: async () => {},
    input: null as UseOnSendInput | null,
    ui: {
      begin: vi.fn(),
      reset: vi.fn(),
      cursor: vi.fn(),
      optimistic: vi.fn(),
    },
  };
}

/** Production hook + real stores, admission, attachments and durable attempt ledger.
 * The harness substitutes editor rendering and settings persistence, not send logic. */
export function useSendHarnessInput({
  threadId,
  control,
  overrides = {},
}: {
  threadId: ThreadId;
  control: ReturnType<typeof createSendControl>;
  overrides?: Partial<UseOnSendInput>;
}) {
  const thread = useStore((state) => state.threads.find((item) => item.id === threadId));
  const project = useStore((state) => state.projects.find((item) => item.id === thread?.projectId));
  const draft = useComposerDraftStore((state) => state.draftsByThreadId[threadId]);
  const promptRef = useRef("");
  promptRef.current = draft?.prompt ?? "";
  const imagesRef = useRef<UseOnSendInput["composerImages"]>([]);
  imagesRef.current = draft?.images ?? [];
  const filesRef = useRef<UseOnSendInput["composerFiles"]>([]);
  filesRef.current = draft?.files ?? [];
  const annotationsRef = useRef<UseOnSendInput["composerAnnotations"]>([]);
  annotationsRef.current = draft?.annotations ?? [];
  const contextsRef = useRef<UseOnSendInput["composerTerminalContexts"]>([]);
  contextsRef.current = draft?.terminalContexts ?? [];
  const sendInFlightRef = useRef(false);
  const shouldAutoScrollRef = useRef(false);
  const store = useComposerDraftStore.getState();
  const input: UseOnSendInput = {
    activeThread: thread,
    activeThreadId: threadId,
    activeProject: project,
    isServerThread: true,
    isLocalDraftThread: false,
    isSendBusy: false,
    isConnecting: false,
    shouldQueuePrompt: () => false,
    isForceSend: () => false,
    sendInFlightRef,
    promptRef,
    composerImages: imagesRef.current,
    composerImagesRef: imagesRef,
    composerFiles: filesRef.current,
    composerFilesRef: filesRef,
    composerAnnotations: annotationsRef.current,
    composerAnnotationsRef: annotationsRef,
    composerTerminalContexts: contextsRef.current,
    composerTerminalContextsRef: contextsRef,
    selectedProvider: "codex",
    selectedModel: "gpt-5.5",
    selectedProviderModels: [],
    selectedPromptEffort: null,
    selectedModelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    isComposerShellMode: false,
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    isOpencodePendingUserInputMode: false,
    activePendingUserInputRequestId: null,
    activePendingUserInput: null,
    bootstrapSourceThreadId: null,
    replyTarget: null,
    shouldAutoScrollRef,
    setOptimisticUserMessages: control.ui.optimistic,
    setComposerCursor: control.ui.cursor,
    setComposerHighlightedItemId: () => {},
    setComposerTrigger: () => {},
    setThreadError: (id, error) => {
      if (id) useStore.getState().setError(id, error);
    },
    setStoreThreadError: (id, error) => useStore.getState().setError(id, error),
    clearComposerDraftContent: store.clearComposerContent,
    setPrompt: (prompt) => store.setPrompt(threadId, prompt),
    setComposerShellMode: (mode) => store.setShellMode(threadId, mode),
    addComposerImagesToDraft: (images) =>
      images.forEach((image) => store.addImage(threadId, image)),
    addComposerFilesToDraft: (files) => files.forEach((file) => store.addFile(threadId, file)),
    addComposerAnnotationsToDraft: (items) =>
      items.forEach((item) => store.addAnnotation(threadId, item)),
    addComposerTerminalContextsToDraft: (items) =>
      items.forEach((item) => store.addTerminalContext(threadId, item)),
    clearBootstrapSourceThreadId: (id) => store.setBootstrapSourceThreadId(id, null),
    setReplyTarget: store.setReplyTarget,
    beginLocalDispatch: control.ui.begin,
    resetLocalDispatch: control.ui.reset,
    forceStickToBottom: () => {},
    scrollToUserTurnAnchor: () => {},
    persistThreadSettingsForNextTurn: async () => {},
    onSubmitPlanFollowUp: async () => false,
    handleInteractionModeChange: () => {},
    onRespondToUserInput: async () => {},
    submitQueuedComposerPrompt: async () => "queued",
    ...overrides,
  };
  control.input = input;
  return input;
}

export function SendHarness(props: Parameters<typeof useSendHarnessInput>[0]) {
  const input = useSendHarnessInput(props);
  props.control.onSend = useOnSend(input);
  return <button onClick={() => void props.control.onSend()}>Send {props.threadId}</button>;
}
