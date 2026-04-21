import type { StoreApi } from "zustand";
import { createComposerContentActions } from "./actions.composer.store";
import { createDraftThreadActions } from "./actions.draftThread.store";
import { createModelActions } from "./actions.model.store";
import { type ComposerDraftStoreState } from "./types.store";

type SetFn = StoreApi<ComposerDraftStoreState>["setState"];
type GetFn = StoreApi<ComposerDraftStoreState>["getState"];

/** Creates all action implementations for the composer draft store. */
export function createComposerDraftActions(
  set: SetFn,
  get: GetFn,
  composerDebouncedStorageFlush: () => void,
): Omit<
  ComposerDraftStoreState,
  | "draftsByThreadId"
  | "draftThreadsByThreadId"
  | "projectDraftThreadIdByProjectId"
  | "stickyModelSelectionByProvider"
  | "stickyActiveProvider"
> {
  return {
    ...createDraftThreadActions(set, get),
    ...createModelActions(set, get),
    ...createComposerContentActions(set, get, composerDebouncedStorageFlush),
  };
}
