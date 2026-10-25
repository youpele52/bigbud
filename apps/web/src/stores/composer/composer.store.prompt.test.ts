import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useComposerDraftStore } from "./composer.store";
import { resetComposerDraftStore } from "./composer.store.test.utils";

describe("composer prompt actions", () => {
  const threadId = ThreadId.makeUnsafe("thread-prompt");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("appends prompt text without replacing an existing draft", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "Review this repository.");
    store.appendPrompt(threadId, "Investigate the Git issue.");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "Review this repository.\n\nInvestigate the Git issue.",
    );
  });

  it("does not add blank prompts", () => {
    useComposerDraftStore.getState().appendPrompt(threadId, "  ");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});
