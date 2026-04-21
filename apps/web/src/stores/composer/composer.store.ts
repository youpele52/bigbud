import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createDebouncedStorage, createMemoryStorage, resolveStorage } from "../../lib/storage";

// ── Re-exports from sub-modules ───────────────────────────────────────

export {
  COMPOSER_DRAFT_LEGACY_STORAGE_KEYS,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  DraftThreadEnvModeSchema,
  EMPTY_PERSISTED_DRAFT_STORE_STATE,
  EMPTY_THREAD_DRAFT,
  PersistedComposerDraftStoreState,
  PersistedComposerDraftStoreStorage,
  PersistedComposerFileAttachment,
  PersistedComposerImageAttachment,
  PersistedComposerThreadDraftState,
  PersistedDraftThreadState,
  PersistedTerminalContextDraft,
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type DraftThreadEnvMode,
  type DraftThreadState,
  type EffectiveComposerModelState,
  type LegacyCodexFields,
  type LegacyPersistedComposerDraftStoreState,
  type LegacyPersistedComposerThreadDraftState,
  type LegacyV2StoreFields,
  type LegacyV2ThreadDraftFields,
  type ProjectDraftThread,
} from "./types.store";

export {
  composerImageDedupKey,
  createEmptyThreadDraft,
  deriveEffectiveComposerModelState,
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacyReplaceProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  modelSelectionByProviderToOptions,
  normalizeModelSelection,
  normalizeProviderKind,
  normalizeProviderModelOptions,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  providerModelOptionsFromSelection,
  revokeObjectPreviewUrl,
  shouldRemoveDraft,
  terminalContextDedupKey,
} from "./normalization.store";

export {
  normalizeDraftThreadEnvMode,
  normalizePersistedAttachment,
  normalizePersistedDraftsByThreadId,
  normalizePersistedDraftThreads,
  normalizePersistedTerminalContextDraft,
} from "./normalizers.store";

export {
  hydratePersistedComposerImageAttachment,
  hydrateImagesFromPersisted,
  partializeComposerDraftStoreState,
  readPersistedAttachmentIdsFromStorage,
  toHydratedThreadDraft,
  verifyPersistedAttachments,
} from "./persistence.store";

export { migratePersistedComposerDraftStoreState } from "./migration.store";

export { useComposerThreadDraft, useEffectiveComposerModelState } from "./selectors.store";

import {
  COMPOSER_DRAFT_LEGACY_STORAGE_KEYS,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  type ComposerDraftStoreState,
} from "./types.store";

import {
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
} from "./migration.store";
import { partializeComposerDraftStoreState, toHydratedThreadDraft } from "./persistence.store";
import { createComposerDraftActions } from "./actions.store";

// ── Debounced storage setup ───────────────────────────────────────────

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

const composerDebouncedStorage = createDebouncedStorage(
  resolveStorage(typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(), {
    legacyKeysByName: {
      [COMPOSER_DRAFT_STORAGE_KEY]: COMPOSER_DRAFT_LEGACY_STORAGE_KEYS,
    },
  }),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

// Flush pending composer draft writes before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

// ── Zustand store ─────────────────────────────────────────────────────

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get) => ({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
      ...createComposerDraftActions(set, get, composerDebouncedStorage.flush),
    }),
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: createJSONStorage(() => composerDebouncedStorage),
      migrate: migratePersistedComposerDraftStoreState,
      partialize: partializeComposerDraftStoreState,
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadId).map(([threadId, draft]) => [
            threadId,
            toHydratedThreadDraft(draft),
          ]),
        );
        return {
          ...currentState,
          draftsByThreadId,
          draftThreadsByThreadId: normalizedPersisted.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: normalizedPersisted.projectDraftThreadIdByProjectId,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

// ── Utility functions ─────────────────────────────────────────────────

/**
 * Clear a draft thread once the server has materialized the same thread id.
 *
 * Use the single-thread helper for live `thread.created` events and the
 * iterable helper for bootstrap/recovery paths that discover multiple server
 * threads at once.
 */
export function clearPromotedDraftThread(threadId: import("@bigbud/contracts").ThreadId): void {
  if (!useComposerDraftStore.getState().getDraftThread(threadId)) {
    return;
  }
  useComposerDraftStore.getState().clearDraftThread(threadId);
}

export function clearPromotedDraftThreads(
  serverThreadIds: Iterable<import("@bigbud/contracts").ThreadId>,
): void {
  for (const threadId of serverThreadIds) {
    clearPromotedDraftThread(threadId);
  }
}
