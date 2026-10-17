import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { useComposerDraftStore, type DraftThreadEnvMode } from "../stores/composer";
import { createEmptyThreadDraft, shouldRemoveDraft } from "../stores/composer/normalization.store";

/** A saved zero-message chat retains its pending first-send worktree choice in composer persistence. */
export function preservePendingEnvMode(threadId: ThreadId, mode: DraftThreadEnvMode): void {
  useComposerDraftStore.setState((state) => {
    const draft = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
    if (draft.pendingEnvMode === mode || (mode === "local" && !draft.pendingEnvMode)) return state;
    const { pendingEnvMode: _previousMode, ...base } = draft;
    const next = mode === "worktree" ? { ...base, pendingEnvMode: mode } : base;
    const draftsByThreadId = { ...state.draftsByThreadId };
    if (shouldRemoveDraft(next)) delete draftsByThreadId[threadId];
    else draftsByThreadId[threadId] = next;
    return { draftsByThreadId };
  });
}
