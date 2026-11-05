import { ApprovalRequestId, MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { beforeEach, expect, it, vi } from "vitest";

import { deriveDisplayedUserMessageState } from "../../../lib/terminalContext";
import { makeThread } from "../../../stores/main/main.store.test.helpers";
import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import { resetComposerDraftStore } from "../../../stores/composer/composer.store.test.utils";
import type { ComposerChatCitationAttachment } from "../../../stores/composer/types.annotation.store";
import { restoreMessageComposerDraftAfterFailure } from "./ChatView.sendTurn.helpers";
import { prepareComposerPrompt } from "./ChatView.sendTurn.prepare";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

const threadId = ThreadId.makeUnsafe("thread-citation");
const citation: ComposerChatCitationAttachment = {
  id: "citation-1",
  kind: "chat",
  comment: "",
  intent: "context",
  createdAt: "2026-10-29T22:00:00.000Z",
  source: { threadId, messageId: MessageId.makeUnsafe("source-message"), role: "assistant" },
  selection: { text: 'exact phrase\n"quoted"', startOffset: 12, endOffset: 33 },
};

const questionCitation: ComposerChatCitationAttachment = {
  ...citation,
  source: {
    kind: "question",
    threadId,
    requestId: ApprovalRequestId.makeUnsafe("theme-request"),
    questionId: "theme",
    region: "question",
  },
};

beforeEach(resetComposerDraftStore);

it.each(
  [citation, questionCitation].flatMap((citation) =>
    ["", "Here is why I cited it."].map((prompt) => ({ citation, prompt })),
  ),
)(
  "delivers an exact quote with composer text '$prompt' through shared send preparation ($citation.source)",
  async ({ citation, prompt }) => {
    const prepared = await prepareComposerPrompt({
      api: {} as never,
      resetComposerDraft: vi.fn(),
      sendInput: {
        activeThread: makeThread({ id: threadId }),
        activeProject: { id: "project-1", cwd: "/project" },
        promptRef: { current: prompt },
        composerAnnotations: [citation],
        composerImages: [],
        composerFiles: [],
        composerTerminalContexts: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedProviderModels: [],
        selectedPromptEffort: null,
        selectedModelSelection: { provider: "codex", model: "gpt-5" },
      } as unknown as UseOnSendInput,
    });

    expect(prepared?.annotations).toEqual([citation]);
    const displayed = deriveDisplayedUserMessageState(prepared!.outgoingMessageText);
    expect(displayed.visibleText).toBe(prompt);
    expect(displayed.annotations).toMatchObject([
      { kind: "chat", source: citation.source, selection: citation.selection },
    ]);
  },
);

it.each([citation, questionCitation])(
  "restores the quote and user's explanation after a failed send or queue ($source)",
  (citation) => {
    const promptRef = { current: "" };
    const setPrompt = vi.fn();
    restoreMessageComposerDraftAfterFailure({
      currentDraftEmpty: true,
      messageIdForSend: null,
      promptText: "My own explanation",
      promptRef,
      replyTarget: null,
      composerImages: [],
      composerFiles: [],
      composerAnnotations: [citation],
      composerTerminalContexts: [],
      setOptimisticUserMessages: vi.fn(),
      revokeUserMessagePreviewUrls: vi.fn(),
      setPrompt,
      setComposerCursor: vi.fn(),
      addComposerImagesToDraft: vi.fn(),
      addComposerFilesToDraft: vi.fn(),
      addComposerAnnotationsToDraft: (annotations) =>
        useComposerDraftStore.getState().addAnnotations(threadId, annotations),
      addComposerTerminalContextsToDraft: vi.fn(),
      setReplyTarget: vi.fn(),
      setComposerTrigger: vi.fn(),
    });

    expect(promptRef.current).toBe("My own explanation");
    expect(setPrompt).toHaveBeenCalledWith("My own explanation");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.annotations).toEqual([
      citation,
    ]);
  },
);
