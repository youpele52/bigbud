import { type ModelSelection, type ServerProvider } from "@bigbud/contracts";
import { useEffect, useMemo } from "react";

import { useSettings } from "~/hooks/useSettings";
import { getDefaultServerModel } from "~/models/provider";
import {
  getComposerProviderFallback,
  isComposerProviderVisible,
} from "~/models/provider/composerVisibility.models";

import { createOrchestraModelSelection } from "./OrchestraPlayerComposer.menu";

export function useOrchestraComposerProviderVisibility(input: {
  modelSelection: ModelSelection;
  providers: ReadonlyArray<ServerProvider>;
  prompt: string;
  onChange: (update: Partial<{ prompt: string; modelSelection: ModelSelection }>) => void;
}) {
  const hiddenComposerProviders = useSettings((settings) => settings.hiddenComposerProviders);
  const composerProviderFallback = useMemo(
    () =>
      isComposerProviderVisible(input.modelSelection.provider, hiddenComposerProviders)
        ? null
        : getComposerProviderFallback(input.providers, hiddenComposerProviders),
    [hiddenComposerProviders, input.modelSelection.provider, input.providers],
  );
  const selectedProvider = composerProviderFallback ?? input.modelSelection.provider;

  useEffect(() => {
    if (!composerProviderFallback) return;
    input.onChange({
      modelSelection: createOrchestraModelSelection({
        provider: selectedProvider,
        model: getDefaultServerModel(input.providers, selectedProvider),
        providers: input.providers,
        prompt: input.prompt,
      }),
    });
  }, [composerProviderFallback, input, selectedProvider]);

  return { hiddenComposerProviders, selectedProvider };
}
