import type { ModelSelection, ProviderKind, ProviderModelOptions } from "@bigbud/contracts";
import { createModelSelection } from "../../models/provider/selection-helpers.models";

/** Picker identity includes the native account, not merely its potentially repeated model ID. */
export function selectTextGenerationModel(
  provider: ProviderKind,
  model: string,
  subProviderID?: string,
): ModelSelection {
  return { ...createModelSelection(provider, model), ...(subProviderID ? { subProviderID } : {}) };
}

/** Editing traits must never discard or reinterpret the selected native account. */
export function updateTextGenerationModelOptions(
  selection: ModelSelection,
  options: ProviderModelOptions[ProviderKind] | undefined,
): ModelSelection {
  return {
    ...createModelSelection(selection.provider, selection.model, options),
    ...("subProviderID" in selection && selection.subProviderID
      ? { subProviderID: selection.subProviderID }
      : {}),
  };
}
