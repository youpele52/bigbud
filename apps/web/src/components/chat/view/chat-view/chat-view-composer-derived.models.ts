import {
  type ModelSelection,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@bigbud/contracts";
import { useMemo } from "react";

import { normalizeModelSlug } from "@bigbud/shared/model";
import {
  createModelSelection,
  getProviderModels,
  resolveSelectableProvider,
} from "../../../../models/provider";
import { useEffectiveComposerModelState } from "../../../../stores/composer";
import { AVAILABLE_PROVIDER_OPTIONS } from "../../provider/ProviderModelPicker";
import { getComposerProviderState } from "../../provider/composerProviderRegistry";
import { getProviderDescriptor, PROVIDER_DESCRIPTORS } from "../../provider/providerDescriptors";
import { getModelSelectionSubProviderID, modelPickerValue } from "../ChatView.modelSelection.logic";
import { threadHasStarted } from "../ChatView.logic";

import type { ChatViewBaseState } from "./chat-view-base-state.hooks";

export function useComposerProviderState(
  base: ChatViewBaseState,
  providerStatuses: ReadonlyArray<ServerProvider>,
) {
  const sessionProvider = base.activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = base.composerDraft.activeProvider ?? null;
  const threadProvider =
    base.activeThread?.modelSelection.provider ??
    base.activeProject?.defaultModelSelection?.provider ??
    null;
  const hasThreadStarted = threadHasStarted(base.activeThread);
  const lockedProvider: ProviderKind | null =
    hasThreadStarted && !base.providerUnlocked
      ? sessionProvider !== "unknown"
        ? (sessionProvider ?? threadProvider ?? selectedProviderByThreadId ?? null)
        : null
      : null;

  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider ?? "codex",
  );
  const selectedProvider: ProviderKind = lockedProvider ?? unlockedSelectedProvider;

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: base.threadId,
    providers: providerStatuses,
    selectedProvider,
    threadModelSelection: base.activeThread?.modelSelection,
    projectModelSelection: base.activeProject?.defaultModelSelection,
    settings: base.settings,
  });

  const selectedProviderModels = getProviderModels(providerStatuses, selectedProvider);
  const selectedDraftOrThreadModelSelection =
    base.composerDraft.modelSelectionByProvider[selectedProvider] ??
    (base.activeThread?.modelSelection.provider === selectedProvider
      ? base.activeThread.modelSelection
      : null) ??
    (base.activeProject?.defaultModelSelection?.provider === selectedProvider
      ? base.activeProject.defaultModelSelection
      : null);

  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        prompt: base.prompt,
        modelOptions: composerModelOptions,
      }),
    [base.prompt, composerModelOptions, selectedModel, selectedProvider, selectedProviderModels],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const selectedModelSelection = useMemo<ModelSelection>(() => {
    const baseSelection = createModelSelection(
      selectedProvider,
      selectedModel,
      selectedModelOptionsForDispatch,
    );
    if (getProviderDescriptor(selectedProvider).supportsSubProviderID) {
      const currentSubProviderID = getModelSelectionSubProviderID(
        selectedDraftOrThreadModelSelection,
      );
      const matched = selectedProviderModels.find(
        (model) =>
          model.slug === selectedModel &&
          (currentSubProviderID === null || model.subProviderID === currentSubProviderID),
      );
      if (matched?.subProviderID) {
        return { ...baseSelection, subProviderID: matched.subProviderID } as ModelSelection;
      }
      if (currentSubProviderID !== null) {
        return { ...baseSelection, subProviderID: currentSubProviderID } as ModelSelection;
      }
    }
    return baseSelection;
  }, [
    selectedDraftOrThreadModelSelection,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
    selectedProviderModels,
  ]);

  const selectedModelForPicker = modelPickerValue(selectedModelSelection);
  const modelOptionsByProvider = useMemo<Record<ProviderKind, ReadonlyArray<ServerProviderModel>>>(
    () =>
      Object.fromEntries(
        PROVIDER_DESCRIPTORS.map((descriptor) => [
          descriptor.provider,
          getProviderModels(providerStatuses, descriptor.provider),
        ]),
      ) as Record<ProviderKind, ReadonlyArray<ServerProviderModel>>,
    [providerStatuses],
  );
  const activeProviderStatus = useMemo(
    () => providerStatuses.find((status) => status.provider === selectedProvider) ?? null,
    [selectedProvider, providerStatuses],
  );

  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    if (getProviderDescriptor(selectedProvider).catalogAuthoritative) {
      // Keep stale catalog values visible but never normalize them into a
      // synthetic custom option. The next picker choice must come from the catalog.
      return selectedModelForPicker;
    }
    return currentOptions.some(
      (option) =>
        modelPickerValue({
          provider: selectedProvider,
          model: option.slug,
          ...(option.subProviderID ? { subProviderID: option.subProviderID } : {}),
        } as ModelSelection) === selectedModelForPicker,
    )
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);

  const searchableModelOptions = useMemo(
    () =>
      AVAILABLE_PROVIDER_OPTIONS.filter(
        (option) => lockedProvider === null || option.value === lockedProvider,
      ).flatMap((option) =>
        modelOptionsByProvider[option.value].map(({ slug, name, subProviderID, group }) => ({
          provider: option.value,
          providerLabel: option.label,
          slug,
          name,
          subProviderID,
          searchSlug: slug.toLowerCase(),
          searchName: name.toLowerCase(),
          searchProvider: option.label.toLowerCase(),
          searchGroup: group?.toLowerCase() ?? "",
        })),
      ),
    [lockedProvider, modelOptionsByProvider],
  );

  return {
    sessionProvider,
    selectedProviderByThreadId,
    threadProvider,
    hasThreadStarted,
    lockedProvider,
    selectedProvider,
    composerModelOptions,
    selectedModel,
    selectedProviderModels,
    selectedDraftOrThreadModelSelection,
    composerProviderState,
    selectedPromptEffort,
    selectedModelOptionsForDispatch,
    selectedModelSelection,
    selectedModelForPicker,
    modelOptionsByProvider,
    activeProviderStatus,
    selectedModelForPickerWithCustomFallback,
    searchableModelOptions,
  };
}
