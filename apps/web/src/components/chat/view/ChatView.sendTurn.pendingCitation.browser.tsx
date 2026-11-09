import { ApprovalRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { useRef } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import type { ComposerChatCitationAttachment } from "../../../stores/composer/types.annotation.store";
import { useOnSend } from "./ChatView.sendTurn.logic";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

vi.mock("../../../rpc/nativeApi", () => ({
  readNativeApi: () => ({}),
  ensureNativeApi: () => ({}),
}));
vi.mock("../../../hooks/useRemoteExecutionAccessGate", () => ({
  useRemoteExecutionAccessGate: () => ({ ensureRemoteExecutionTargetAccess: vi.fn() }),
}));

const threadId = ThreadId.makeUnsafe("pending-citation-thread");
const requestId = ApprovalRequestId.makeUnsafe("theme-request");
const quote: ComposerChatCitationAttachment = {
  id: "question-quote",
  kind: "chat",
  intent: "context",
  comment: "",
  createdAt: "2026-10-30T00:00:00.000Z",
  source: { kind: "question", threadId, requestId, questionId: "theme", region: "question" },
  selection: { text: "Which theme?", startOffset: 0, endOffset: 12 },
};

function useDraftRefs(id: ThreadId) {
  const annotations = useComposerDraftStore.getState().draftsByThreadId[id]?.annotations ?? [];
  const sendInFlightRef = useRef(false);
  const composerImagesRef = useRef<UseOnSendInput["composerImages"]>([]);
  const composerFilesRef = useRef<UseOnSendInput["composerFiles"]>([]);
  const composerAnnotationsRef = useRef(annotations);
  composerAnnotationsRef.current = annotations;
  const composerTerminalContextsRef = useRef<UseOnSendInput["composerTerminalContexts"]>([]);
  return {
    sendInFlightRef,
    composerImages: composerImagesRef.current,
    composerImagesRef,
    composerFiles: composerFilesRef.current,
    composerFilesRef,
    composerAnnotations: annotations,
    composerAnnotationsRef,
    composerTerminalContexts: composerTerminalContextsRef.current,
    composerTerminalContextsRef,
  };
}

beforeEach(() => useComposerDraftStore.setState({ draftsByThreadId: {} }));

it("preserves the submitted thread's citations without changing a newly selected thread", async () => {
  const otherThreadId = ThreadId.makeUnsafe("other-pending-thread");
  const otherQuote = {
    ...quote,
    id: "other-quote",
    source: { ...quote.source, threadId: otherThreadId },
  };
  const store = useComposerDraftStore.getState();
  store.addAnnotation(threadId, quote);
  store.addAnnotation(otherThreadId, otherQuote);
  store.setPrompt(threadId, "Dark");
  store.setPrompt(otherThreadId, "Unsent answer in B");
  const promptRef = { current: "Dark" };
  const resetEditor = vi.fn();
  let resolveAnswer!: () => void;
  const respond = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveAnswer = resolve;
      }),
  );
  let sendResult: Promise<unknown> | undefined;
  function Harness({ id }: { id: typeof threadId }) {
    const send = useOnSend({
      activeThread: { id },
      selectedProvider: "codex",
      ...useDraftRefs(id),
      promptRef,
      isOpencodePendingUserInputMode: true,
      activePendingUserInputRequestId: requestId,
      activePendingUserInput: { requestId, questions: [{ id: "theme" }] },
      onRespondToUserInput: respond,
      clearComposerDraftContent: (target: typeof threadId) =>
        useComposerDraftStore.getState().clearComposerContent(target),
      addComposerAnnotationsToDraft: (annotations: ComposerChatCitationAttachment[]) =>
        useComposerDraftStore.getState().addAnnotations(id, annotations),
      setComposerHighlightedItemId: resetEditor,
      setComposerCursor: resetEditor,
      setComposerTrigger: resetEditor,
    } as unknown as UseOnSendInput);
    return (
      <button
        type="button"
        onClick={() => {
          sendResult = send();
        }}
      >
        Submit answer
      </button>
    );
  }
  const screen = await render(<Harness id={threadId} />);
  try {
    await screen.getByRole("button", { name: "Submit answer" }).click();
    await screen.rerender(<Harness id={otherThreadId} />);
    promptRef.current = "Unsent answer in B";
    resolveAnswer();
    await sendResult;
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.annotations).toEqual([
      quote,
    ]);
    expect(useComposerDraftStore.getState().draftsByThreadId[otherThreadId]?.annotations).toEqual([
      otherQuote,
    ]);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("");
    expect(useComposerDraftStore.getState().draftsByThreadId[otherThreadId]?.prompt).toBe(
      "Unsent answer in B",
    );
    expect(promptRef.current).toBe("Unsent answer in B");
    expect(resetEditor).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it.each(["success", "failure", "empty"] as const)(
  "preserves citations on pending answer %s without altering answer semantics",
  async (mode) => {
    const store = useComposerDraftStore.getState();
    store.addAnnotation(threadId, quote);
    const promptRef = { current: mode === "empty" ? "  " : "  Dark  " };
    const respond = vi.fn(async () => {
      if (mode === "failure") throw new Error("answer rejected");
    });
    let sendResult: Promise<unknown> | undefined;
    function SafeHarness() {
      const send = useOnSend({
        activeThread: { id: threadId },
        selectedProvider: "codex",
        ...useDraftRefs(threadId),
        promptRef,
        isOpencodePendingUserInputMode: true,
        activePendingUserInputRequestId: requestId,
        activePendingUserInput: { requestId, questions: [{ id: "theme" }] },
        onRespondToUserInput: respond,
        clearComposerDraftContent: () => {
          useComposerDraftStore.getState().removeAnnotation(threadId, quote.id);
        },
        addComposerAnnotationsToDraft: (annotations: ComposerChatCitationAttachment[]) =>
          useComposerDraftStore.getState().addAnnotations(threadId, annotations),
        setComposerHighlightedItemId: vi.fn(),
        setComposerCursor: vi.fn(),
        setComposerTrigger: vi.fn(),
      } as unknown as UseOnSendInput);
      return (
        <button
          type="button"
          onClick={() => {
            sendResult = send().catch((error: unknown) => error);
          }}
        >
          Submit answer
        </button>
      );
    }
    const screen = await render(<SafeHarness />);
    await screen.getByRole("button", { name: "Submit answer" }).click();
    await sendResult;
    if (mode === "empty") expect(respond).not.toHaveBeenCalled();
    else expect(respond).toHaveBeenCalledExactlyOnceWith(requestId, { theme: "Dark" });
    expect(promptRef.current).toBe(mode === "success" ? "" : mode === "empty" ? "  " : "  Dark  ");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.annotations).toEqual([
      quote,
    ]);
    await screen.unmount();
  },
);
