import type { ModelSelection, ProviderKind, ServerProvider } from "@bigbud/contracts";
import { PROVIDER_KINDS } from "@bigbud/contracts";
import { useMemo } from "react";

import { ProviderModelPicker } from "~/components/chat/provider/ProviderModelPicker";
import type { ModelOption } from "~/components/chat/provider/ProviderModelPicker.models";

function selectionValue(selection: ModelSelection): string {
  return "subProviderID" in selection && selection.subProviderID
    ? `${selection.model}::${selection.subProviderID}`
    : selection.model;
}

function buildModelOptionsByProvider(
  providers: ReadonlyArray<ServerProvider>,
): Record<ProviderKind, ReadonlyArray<ModelOption>> {
  const result = {} as Record<ProviderKind, ReadonlyArray<ModelOption>>;

  for (const provider of PROVIDER_KINDS) {
    result[provider] = [];
  }

  for (const provider of providers) {
    result[provider.provider] = provider.models.map((model) => ({
      slug: model.slug,
      name: model.name ?? model.slug,
      group: model.group ?? undefined,
      subProviderID: model.subProviderID ?? undefined,
      availability: model.availability,
    }));
  }

  return result;
}

interface MobileComposerModelPickerProps {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly lockedProvider: ProviderKind | null;
  readonly onChange: (next: ModelSelection) => void;
  readonly onProviderUnlock?: () => void;
}

export function MobileComposerModelPicker({
  selection,
  providers,
  lockedProvider,
  onChange,
  onProviderUnlock,
}: MobileComposerModelPickerProps) {
  const modelOptionsByProvider = useMemo(() => buildModelOptionsByProvider(providers), [providers]);
  const menuItemClassName = "min-h-11 text-sm sm:min-h-11 sm:text-sm";
  const searchbarClassName =
    "px-3 py-0 [&_input]:min-h-11 [&_input]:w-full [&_input]:text-sm [&_input]:placeholder:text-sm [&_button]:min-h-11 [&_button]:min-w-11";
  const popupClassName = "[--available-height:33vh] !max-h-[50vh]";
  const subPopupClassName =
    "[--available-height:33vh] !max-h-[50vh] w-[min(66vw,calc(var(--anchor-width)*2.5))] max-w-[66vw]";

  return (
    <ProviderModelPicker
      compact
      lockedProvider={lockedProvider}
      model={selectionValue(selection)}
      menuItemClassName={menuItemClassName}
      modelListGroupLabelClassName="px-3 text-sm font-normal"
      modelListItemClassName={`${menuItemClassName} items-center pe-3 ps-3`}
      modelListItemLabelClassName="whitespace-normal break-words leading-snug"
      modelListSearchbarClassName={searchbarClassName}
      modelOptionsByProvider={modelOptionsByProvider}
      popupClassName={popupClassName}
      provider={selection.provider}
      providers={providers}
      subPopupClassName={subPopupClassName}
      triggerClassName="min-h-11 max-w-[60vw] rounded-lg border-transparent bg-transparent px-1.5 text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground/80 focus-visible:bg-muted/40"
      triggerVariant="ghost"
      {...(onProviderUnlock ? { onProviderUnlock } : {})}
      onProviderModelChange={(provider, model, subProviderID) => {
        if (
          subProviderID &&
          (provider === "opencode" || provider === "opencodeV2" || provider === "pi")
        ) {
          onChange({ provider, model, subProviderID } as ModelSelection);
          return;
        }
        onChange({ provider, model });
      }}
    />
  );
}
