import { type ComponentProps, type ReactNode, forwardRef } from "react";
import {
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
} from "@bigbud/contracts";
import type { ServerProvider } from "@bigbud/contracts";
import { cn } from "~/lib/utils";
import { ProviderModelPicker } from "../provider/ProviderModelPicker";
import { CompactComposerControlsMenu } from "../common/CompactComposerControlsMenu";

type ModelOptionsByProvider = ComponentProps<typeof ProviderModelPicker>["modelOptionsByProvider"];
interface ComposerFooterLeadingProps {
  selectedProvider: ProviderKind;
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ProviderKind | null;
  providerStatuses: readonly ServerProvider[];
  modelOptionsByProvider: ModelOptionsByProvider;
  composerProviderState: {
    modelPickerIconClassName?: string;
  };
  hasThreadStarted: boolean;
  planCardOpen: boolean;
  planCardLabel: string;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  providerTraitsMenuContent: ReactNode;
  onOpenOrchestra: () => void;
  onProviderModelSelect: (provider: ProviderKind, model: string, subProviderID?: string) => void;
  onProviderUnlock: () => void;
  onToggleInteractionMode: () => void;
  onTogglePlanCard: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}

export const ComposerFooterLeading = forwardRef<HTMLDivElement, ComposerFooterLeadingProps>(
  function ComposerFooterLeading(
    {
      selectedProvider,
      selectedModelForPickerWithCustomFallback,
      lockedProvider,
      providerStatuses,
      modelOptionsByProvider,
      composerProviderState,
      hasThreadStarted,
      planCardOpen,
      planCardLabel,
      interactionMode,
      runtimeMode,
      providerTraitsMenuContent,
      onOpenOrchestra,
      onProviderModelSelect,
      onProviderUnlock,
      onToggleInteractionMode,
      onTogglePlanCard,
      onRuntimeModeChange,
    }: ComposerFooterLeadingProps,
    ref,
  ) {
    return (
      <div
        ref={ref}
        className={cn(
          "-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        <ProviderModelPicker
          compact
          provider={selectedProvider}
          model={selectedModelForPickerWithCustomFallback}
          lockedProvider={lockedProvider}
          providers={providerStatuses}
          modelOptionsByProvider={modelOptionsByProvider}
          enableRecentlyUsed
          {...(composerProviderState.modelPickerIconClassName
            ? { activeProviderIconClassName: composerProviderState.modelPickerIconClassName }
            : {})}
          onProviderModelChange={onProviderModelSelect}
          {...(hasThreadStarted ? { onProviderUnlock } : {})}
        />

        <CompactComposerControlsMenu
          interactionMode={interactionMode}
          planCardOpen={planCardOpen}
          planCardLabel={planCardLabel}
          runtimeMode={runtimeMode}
          traitsMenuContent={providerTraitsMenuContent}
          onOpenOrchestra={onOpenOrchestra}
          onToggleInteractionMode={onToggleInteractionMode}
          onTogglePlanCard={onTogglePlanCard}
          onRuntimeModeChange={onRuntimeModeChange}
        />
      </div>
    );
  },
);
