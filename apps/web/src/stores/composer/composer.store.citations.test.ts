import { ApprovalRequestId, MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { beforeEach, describe, expect, it } from "vitest";

import { useComposerDraftStore } from "./composer.store";
import { makeImage, resetComposerDraftStore } from "./composer.store.test.utils";
import { normalizePersistedDraftsByThreadId } from "./normalizers.store";
import { partializeComposerDraftStoreState, toHydratedThreadDraft } from "./persistence.store";
import type { ComposerChatCitationAttachment } from "./types.annotation.store";

const threadId = ThreadId.makeUnsafe("thread-citation");
const quote: ComposerChatCitationAttachment = {
  id: "quote-1",
  kind: "chat",
  comment: "",
  intent: "context",
  createdAt: "2026-10-29T22:00:00.000Z",
  source: { threadId, messageId: MessageId.makeUnsafe("message-source"), role: "assistant" },
  selection: { text: "  exactly this phrase\n", startOffset: 10, endOffset: 32 },
};

describe("composer chat citations", () => {
  beforeEach(resetComposerDraftStore);

  it("keeps multiple quotes separate from the user's explanation and thread drafts", () => {
    const store = useComposerDraftStore.getState();
    store.addAnnotation(threadId, quote);
    store.addAnnotation(threadId, {
      ...quote,
      id: "quote-2",
      selection: { ...quote.selection, text: "second phrase" },
    });
    store.addAnnotation(threadId, quote);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(draft.prompt).toBe("");
    expect(draft.annotations).toHaveLength(2);
    expect(draft.annotations[0]).toEqual(quote);
    expect(
      useComposerDraftStore.getState().draftsByThreadId[ThreadId.makeUnsafe("another-thread")],
    ).toBeUndefined();
  });

  it("persists and hydrates source metadata and exact whitespace without images", () => {
    useComposerDraftStore.getState().addAnnotation(threadId, quote);
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    const drafts = normalizePersistedDraftsByThreadId(
      JSON.parse(JSON.stringify(persisted.draftsByThreadId)),
    );
    const hydrated = toHydratedThreadDraft(drafts[threadId]!);
    expect(hydrated.annotations).toEqual([quote]);
    expect(hydrated.prompt).toBe("");
  });

  it("persists and hydrates question citations without inventing a message identity", () => {
    const questionQuote: ComposerChatCitationAttachment = {
      ...quote,
      source: {
        kind: "question",
        threadId,
        requestId: ApprovalRequestId.makeUnsafe("theme-request"),
        questionId: "theme",
        region: "question",
      },
    };
    useComposerDraftStore.getState().addAnnotation(threadId, questionQuote);
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    const drafts = normalizePersistedDraftsByThreadId(
      JSON.parse(JSON.stringify(persisted.draftsByThreadId)),
    );
    expect(toHydratedThreadDraft(drafts[threadId]!).annotations).toEqual([questionQuote]);
  });

  it("retains citations when an unrelated screenshot is removed", () => {
    const store = useComposerDraftStore.getState();
    store.addImage(threadId, makeImage({ id: "image-1", previewUrl: "blob:image-1" }));
    store.addAnnotation(threadId, quote);
    store.removeImage(threadId, "image-1");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.annotations).toEqual([
      quote,
    ]);
    store.removeAnnotation(threadId, quote.id);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("drops corrupt persisted citations without discarding a valid quote", () => {
    const drafts = normalizePersistedDraftsByThreadId({
      [threadId]: {
        prompt: "My explanation",
        attachments: [],
        annotations: [
          quote,
          { ...quote, id: "bad-range", selection: { ...quote.selection, startOffset: -1 } },
          { ...quote, id: "bad-source", source: { ...quote.source, messageId: "" } },
        ],
      },
    });
    expect(drafts[threadId]?.annotations).toEqual([quote]);
    expect(drafts[threadId]?.prompt).toBe("My explanation");
  });
});
