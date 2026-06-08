import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { useComposerDraftStore } from "./composer.store";
import { modelSelection, resetComposerDraftStore } from "./composer.store.test.utils";

describe("composerDraftStore sticky composer settings", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a sticky model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("normalizes empty sticky model options by dropping selection options", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(modelSelection("codex", "gpt-5.4"));

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4"),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("applies sticky activeProvider to new drafts", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-sticky-active-provider");

    store.setStickyModelSelection(modelSelection("claudeAgent", "opus"));
    store.applyStickyState(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      modelSelectionByProvider: {
        claudeAgent: modelSelection("claudeAgent", "opus"),
      },
      activeProvider: "claudeAgent",
    });
  });
});

describe("composerDraftStore provider-scoped option updates", () => {
  const threadId = ThreadId.makeUnsafe("thread-provider");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("retains off-provider option memory without changing the active selection", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadId,
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
      }),
    );
    store.setProviderModelOptions(threadId, "claudeAgent", { effort: "max" });
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.3-codex", { reasoningEffort: "medium" }),
    );
    expect(draft?.modelSelectionByProvider.claudeAgent?.options).toEqual({ effort: "max" });
    expect(draft?.activeProvider).toBe("codex");
  });
});
