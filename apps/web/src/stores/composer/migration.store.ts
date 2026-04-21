import { type ModelSelection, type ProviderKind } from "@bigbud/contracts";
import {
  EMPTY_PERSISTED_DRAFT_STORE_STATE,
  type LegacyPersistedComposerDraftStoreState,
  type PersistedComposerDraftStoreState,
} from "./types.store";
import {
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  normalizeModelSelection,
  normalizeProviderKind,
  normalizeProviderModelOptions,
} from "./normalization.store";
import {
  normalizePersistedDraftsByThreadId,
  normalizePersistedDraftThreads,
} from "./normalizers.store";

// ── Migration (version migration step) ───────────────────────────────

export function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const candidate = persistedState as LegacyPersistedComposerDraftStoreState;
  const rawDraftMap = candidate.draftsByThreadId;
  const rawDraftThreadsByThreadId = candidate.draftThreadsByThreadId;
  const rawProjectDraftThreadIdByProjectId = candidate.projectDraftThreadIdByProjectId;

  // Migrate sticky state from v2 (dual) to v3 (consolidated)
  const stickyModelOptions = normalizeProviderModelOptions(candidate.stickyModelOptions) ?? {};
  const normalizedStickyModelSelection = normalizeModelSelection(candidate.stickyModelSelection, {
    provider: candidate.stickyProvider ?? "codex",
    model: candidate.stickyModel,
    modelOptions: stickyModelOptions,
  });
  const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
    normalizedStickyModelSelection,
    stickyModelOptions,
  );
  const stickyModelSelection = legacySyncModelSelectionOptions(
    normalizedStickyModelSelection,
    nextStickyModelOptions,
  );
  const stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
    stickyModelSelection,
    nextStickyModelOptions,
  );
  const stickyActiveProvider = normalizeProviderKind(candidate.stickyProvider) ?? null;

  const { draftThreadsByThreadId, projectDraftThreadIdByProjectId } =
    normalizePersistedDraftThreads(rawDraftThreadsByThreadId, rawProjectDraftThreadIdByProjectId);
  const draftsByThreadId = normalizePersistedDraftsByThreadId(rawDraftMap);
  return {
    draftsByThreadId,
    draftThreadsByThreadId,
    projectDraftThreadIdByProjectId,
    stickyModelSelectionByProvider,
    stickyActiveProvider,
  };
}

// ── Current-version normalization (for merge hook) ────────────────────

export function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState;
  const { draftThreadsByThreadId, projectDraftThreadIdByProjectId } =
    normalizePersistedDraftThreads(
      normalizedPersistedState.draftThreadsByThreadId,
      normalizedPersistedState.projectDraftThreadIdByProjectId,
    );

  // Handle both v3 (modelSelectionByProvider) and v2/legacy formats
  let stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>> = {};
  let stickyActiveProvider: ProviderKind | null = null;
  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    typeof normalizedPersistedState.stickyModelSelectionByProvider === "object"
  ) {
    stickyModelSelectionByProvider =
      normalizedPersistedState.stickyModelSelectionByProvider as Partial<
        Record<ProviderKind, ModelSelection>
      >;
    stickyActiveProvider = normalizeProviderKind(normalizedPersistedState.stickyActiveProvider);
  } else {
    // Legacy migration path
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {};
    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider,
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    );
    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    );
    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    );
    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    );
    stickyActiveProvider = normalizeProviderKind(normalizedPersistedState.stickyProvider);
  }

  return {
    draftsByThreadId: normalizePersistedDraftsByThreadId(normalizedPersistedState.draftsByThreadId),
    draftThreadsByThreadId,
    projectDraftThreadIdByProjectId,
    stickyModelSelectionByProvider,
    stickyActiveProvider,
  };
}
