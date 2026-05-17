import { type ThreadId } from "@bigbud/contracts";
import type { StoreApi } from "zustand";
import {
  ensureInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../../lib/terminalContext";
import {
  createEmptyThreadDraft,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  shouldRemoveDraft,
  terminalContextDedupKey,
} from "./normalization.store";
import { createComposerAttachmentActions } from "./actions.composer.attachments.store";
import { type ComposerDraftStoreState, type ComposerThreadDraftState } from "./types.store";

type SetFn = StoreApi<ComposerDraftStoreState>["setState"];
type GetFn = StoreApi<ComposerDraftStoreState>["getState"];

/** Composer content actions: prompt, terminal contexts, images, and attachment persistence. */
export function createComposerContentActions(
  set: SetFn,
  get: GetFn,
  composerDebouncedStorageFlush: () => void,
) {
  return {
    ...createComposerAttachmentActions(set, get, composerDebouncedStorageFlush),
    setPrompt: (threadId: ThreadId, prompt: string) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setShellMode: (threadId: ThreadId, shellMode: boolean) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && !shellMode) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...(existing ?? createEmptyThreadDraft()),
          shellMode,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt: ensureInlineTerminalContextPlaceholders(
            existing.prompt,
            normalizedContexts.length,
          ),
          terminalContexts: normalizedContexts,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    insertTerminalContext: (
      threadId: ThreadId,
      prompt: string,
      context: TerminalContextDraft,
      index: number,
    ) => {
      if (threadId.length === 0) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const normalizedContext = normalizeTerminalContextForThread(threadId, context);
        if (!normalizedContext) {
          return state;
        }
        const dedupKey = terminalContextDedupKey(normalizedContext);
        if (
          existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
          existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
        ) {
          return state;
        }
        inserted = true;
        const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
          terminalContexts: [
            ...existing.terminalContexts.slice(0, boundedIndex),
            normalizedContext,
            ...existing.terminalContexts.slice(boundedIndex),
          ],
        };
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: nextDraft,
          },
        };
      });
      return inserted;
    },
    addTerminalContext: (threadId: ThreadId, context: TerminalContextDraft) => {
      if (threadId.length === 0) {
        return;
      }
      get().addTerminalContexts(threadId, [context]);
    },
    addTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => {
      if (threadId.length === 0 || contexts.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
          ...existing.terminalContexts,
          ...contexts,
        ]).slice(existing.terminalContexts.length);
        if (acceptedContexts.length === 0) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              prompt: ensureInlineTerminalContextPlaceholders(
                existing.prompt,
                existing.terminalContexts.length + acceptedContexts.length,
              ),
              terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
            },
          },
        };
      });
    },
    removeTerminalContext: (threadId: ThreadId, contextId: string) => {
      if (threadId.length === 0 || contextId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: current.terminalContexts.filter((context) => context.id !== contextId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearTerminalContexts: (threadId: ThreadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.terminalContexts.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearComposerContent: (threadId: ThreadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: "",
          shellMode: false,
          images: [],
          files: [],
          annotations: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
          persistedFileAttachments: [],
          terminalContexts: [],
          replyTarget: null,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setBootstrapSourceThreadId: (
      threadId: ThreadId,
      sourceThreadId: ThreadId | null | undefined,
    ) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedSourceThreadId = sourceThreadId ?? null;
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && normalizedSourceThreadId === null) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...(existing ?? createEmptyThreadDraft()),
          bootstrapSourceThreadId: normalizedSourceThreadId,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setReplyTarget: (
      threadId: ThreadId,
      replyTarget: ComposerThreadDraftState["replyTarget"] | undefined,
    ) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedReplyTarget = replyTarget ?? null;
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && normalizedReplyTarget === null) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...(existing ?? createEmptyThreadDraft()),
          replyTarget: normalizedReplyTarget,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
  };
}
