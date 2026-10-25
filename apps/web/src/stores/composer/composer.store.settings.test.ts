import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { useComposerDraftStore } from "./composer.store";
import { resetComposerDraftStore } from "./composer.store.test.utils";
import { preservePendingEnvMode } from "../../lib/threadMaterialization.envMode";
import { partializeComposerDraftStoreState, toHydratedThreadDraft } from "./persistence.store";
import { normalizePersistedDraftsByThreadId } from "./normalizers.store";

describe("composerDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.makeUnsafe("thread-settings");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("keeps a zero-message saved chat's pending worktree choice across persistence and cleanup", () => {
    preservePendingEnvMode(threadId, "worktree");
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.pendingEnvMode).toBe("worktree");
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    const normalized = normalizePersistedDraftsByThreadId(persisted.draftsByThreadId);
    expect(normalized[threadId]?.pendingEnvMode).toBe("worktree");
    expect(toHydratedThreadDraft(normalized[threadId]!).pendingEnvMode).toBe("worktree");
    useComposerDraftStore.getState().setRuntimeMode(threadId, null);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.pendingEnvMode).toBe(
      "worktree",
    );
    preservePendingEnvMode(threadId, "local");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("stores runtime mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
      "approval-required",
    );
  });

  it("stores interaction mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setInteractionMode(threadId, "plan");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.interactionMode).toBe(
      "plan",
    );
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");
    store.setInteractionMode(threadId, "plan");
    store.setRuntimeMode(threadId, null);
    store.setInteractionMode(threadId, null);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});
