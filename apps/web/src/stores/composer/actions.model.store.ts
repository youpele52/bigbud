import {
  DEFAULT_MODEL_BY_PROVIDER,
  PROVIDER_KINDS,
  type ModelSelection,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderModelOptions,
  type RuntimeMode,
  type ThreadId,
} from "@bigbud/contracts";
import * as Equal from "effect/Equal";
import type { StoreApi } from "zustand";
import { cloneModelSelection, createModelSelection } from "../../models/provider";
import {
  createEmptyThreadDraft,
  normalizeModelSelection,
  normalizeProviderModelOptions,
  shouldRemoveDraft,
} from "./normalization.store";
import { type ComposerDraftStoreState, type ComposerThreadDraftState } from "./types.store";

type SetFn = StoreApi<ComposerDraftStoreState>["setState"];
type GetFn = StoreApi<ComposerDraftStoreState>["getState"];

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "approval-required" || value === "auto-accept-edits" || value === "full-access";
}

function upsertModelSelectionWithOptions(
  provider: ProviderKind,
  current: ModelSelection | undefined,
  options: ProviderModelOptions[ProviderKind],
): ModelSelection {
  switch (provider) {
    case "codex": {
      const codexOptions = options as NonNullable<ProviderModelOptions["codex"]>;
      return current?.provider === "codex"
        ? cloneModelSelection(current, { options: codexOptions })
        : createModelSelection("codex", DEFAULT_MODEL_BY_PROVIDER.codex, codexOptions);
    }
    case "claudeAgent": {
      const claudeOptions = options as NonNullable<ProviderModelOptions["claudeAgent"]>;
      return current?.provider === "claudeAgent"
        ? cloneModelSelection(current, { options: claudeOptions })
        : createModelSelection("claudeAgent", DEFAULT_MODEL_BY_PROVIDER.claudeAgent, claudeOptions);
    }
    case "copilot": {
      const copilotOptions = options as NonNullable<ProviderModelOptions["copilot"]>;
      return current?.provider === "copilot"
        ? cloneModelSelection(current, { options: copilotOptions })
        : createModelSelection("copilot", DEFAULT_MODEL_BY_PROVIDER.copilot, copilotOptions);
    }
    case "opencode": {
      const opencodeOptions = options as NonNullable<ProviderModelOptions["opencode"]>;
      return current?.provider === "opencode"
        ? cloneModelSelection(current, { options: opencodeOptions })
        : createModelSelection("opencode", DEFAULT_MODEL_BY_PROVIDER.opencode, opencodeOptions);
    }
    case "pi": {
      const piOptions = options as NonNullable<ProviderModelOptions["pi"]>;
      return current?.provider === "pi"
        ? cloneModelSelection(current, { options: piOptions })
        : createModelSelection("pi", DEFAULT_MODEL_BY_PROVIDER.pi, piOptions);
    }
    case "cursor": {
      const cursorOptions = options as NonNullable<ProviderModelOptions["cursor"]>;
      return current?.provider === "cursor"
        ? cloneModelSelection(current, { options: cursorOptions })
        : createModelSelection("cursor", DEFAULT_MODEL_BY_PROVIDER.cursor, cursorOptions);
    }
  }
}

/** Model selection and sticky-state actions for the composer draft store. */
export function createModelActions(set: SetFn, _get: GetFn) {
  return {
    setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => {
      const normalized = normalizeModelSelection(modelSelection);
      set((state) => {
        if (!normalized) {
          return state;
        }
        const nextMap: Partial<Record<ProviderKind, ModelSelection>> = {
          ...state.stickyModelSelectionByProvider,
          [normalized.provider]: normalized,
        };
        if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
          return state.stickyActiveProvider === normalized.provider
            ? state
            : { stickyActiveProvider: normalized.provider };
        }
        return {
          stickyModelSelectionByProvider: nextMap,
          stickyActiveProvider: normalized.provider,
        };
      });
    },
    applyStickyState: (threadId: ThreadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const stickyMap = state.stickyModelSelectionByProvider;
        const stickyActiveProvider = state.stickyActiveProvider;
        if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null) {
          return state;
        }
        const existing = state.draftsByThreadId[threadId];
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        for (const [provider, selection] of Object.entries(stickyMap)) {
          if (selection) {
            const current = nextMap[provider as ProviderKind];
            nextMap[provider as ProviderKind] = {
              ...selection,
              model: current?.model ?? selection.model,
            };
          }
        }
        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          base.activeProvider === stickyActiveProvider
        ) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
          activeProvider: stickyActiveProvider,
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
    setModelSelection: (threadId: ThreadId, modelSelection: ModelSelection | null | undefined) => {
      if (threadId.length === 0) {
        return;
      }
      const normalized = normalizeModelSelection(modelSelection);
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && normalized === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        if (normalized) {
          const current = nextMap[normalized.provider];
          if (normalized.options !== undefined) {
            // Explicit options provided → use them
            nextMap[normalized.provider] = normalized;
          } else {
            // No options in selection → preserve existing options, update provider+model
            nextMap[normalized.provider] =
              current?.options !== undefined
                ? cloneModelSelection(normalized, {
                    options: current.options,
                  } as Partial<ModelSelection>)
                : normalized;
          }
        }
        const nextActiveProvider = normalized?.provider ?? base.activeProvider;
        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          base.activeProvider === nextActiveProvider
        ) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
          activeProvider: nextActiveProvider,
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
    setModelOptions: (
      threadId: ThreadId,
      modelOptions: ProviderModelOptions | null | undefined,
    ) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedOpts = normalizeProviderModelOptions(modelOptions);
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && normalizedOpts === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        for (const provider of PROVIDER_KINDS) {
          // Only touch providers explicitly present in the input
          if (!normalizedOpts || !(provider in normalizedOpts)) continue;
          const opts = normalizedOpts[provider];
          const current = nextMap[provider];
          if (opts) {
            nextMap[provider] = upsertModelSelectionWithOptions(provider, current, opts);
          } else if (current?.options) {
            // Remove options but keep the selection
            const { options: _, ...rest } = current;
            nextMap[provider] = rest as ModelSelection;
          }
        }
        if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
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
    setProviderModelOptions: (
      threadId: ThreadId,
      provider: ProviderKind,
      nextProviderOptions: ProviderModelOptions[ProviderKind] | null | undefined,
      options?: { persistSticky?: boolean },
    ) => {
      if (threadId.length === 0) {
        return;
      }
      // Normalize just this provider's options
      const normalizedOpts = normalizeProviderModelOptions(
        { [provider]: nextProviderOptions },
        provider,
      );
      const providerOpts = normalizedOpts?.[provider];

      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        const base = existing ?? createEmptyThreadDraft();

        // Update the map entry for this provider
        const nextMap = { ...base.modelSelectionByProvider };
        const currentForProvider = nextMap[provider];
        if (providerOpts) {
          nextMap[provider] = upsertModelSelectionWithOptions(
            provider,
            currentForProvider,
            providerOpts,
          );
        } else if (currentForProvider?.options) {
          const { options: _, ...rest } = currentForProvider;
          nextMap[provider] = rest as ModelSelection;
        }

        // Handle sticky persistence
        let nextStickyMap = state.stickyModelSelectionByProvider;
        let nextStickyActiveProvider = state.stickyActiveProvider;
        if (options?.persistSticky === true) {
          nextStickyMap = { ...state.stickyModelSelectionByProvider };
          const stickyBase =
            nextStickyMap[provider] ??
            base.modelSelectionByProvider[provider] ??
            createModelSelection(provider, DEFAULT_MODEL_BY_PROVIDER[provider]);
          if (providerOpts) {
            nextStickyMap[provider] = upsertModelSelectionWithOptions(
              provider,
              stickyBase,
              providerOpts,
            );
          } else if (stickyBase.options) {
            const { options: _, ...rest } = stickyBase;
            nextStickyMap[provider] = rest as ModelSelection;
          }
          nextStickyActiveProvider = base.activeProvider ?? provider;
        }

        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
          state.stickyActiveProvider === nextStickyActiveProvider
        ) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }

        return {
          draftsByThreadId: nextDraftsByThreadId,
          ...(options?.persistSticky === true
            ? {
                stickyModelSelectionByProvider: nextStickyMap,
                stickyActiveProvider: nextStickyActiveProvider,
              }
            : {}),
        };
      });
    },
    setRuntimeMode: (threadId: ThreadId, runtimeMode: RuntimeMode | null | undefined) => {
      if (threadId.length === 0) {
        return;
      }
      const nextRuntimeMode: RuntimeMode | null = isRuntimeMode(runtimeMode) ? runtimeMode : null;
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && nextRuntimeMode === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        if (base.runtimeMode === nextRuntimeMode) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          runtimeMode: nextRuntimeMode,
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
    setInteractionMode: (
      threadId: ThreadId,
      interactionMode: ProviderInteractionMode | null | undefined,
    ) => {
      if (threadId.length === 0) {
        return;
      }
      const nextInteractionMode: ProviderInteractionMode | null =
        interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && nextInteractionMode === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        if (base.interactionMode === nextInteractionMode) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          interactionMode: nextInteractionMode,
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
