import { type ComponentProps, forwardRef } from "react";
import { BotIcon, ListTodoIcon, LockIcon, LockOpenIcon, PenLineIcon } from "lucide-react";
import {
  type ProviderInteractionMode,
  type RuntimeMode,
  type ProviderKind,
} from "@bigbud/contracts";
import type { ServerProvider } from "@bigbud/contracts";
import { Button } from "../../ui/button";
import { Separator } from "../../ui/separator";
import { cn } from "~/lib/utils";
import { ProviderModelPicker } from "../provider/ProviderModelPicker";
import { CompactComposerControlsMenu } from "../common/CompactComposerControlsMenu";

function runtimeModeMeta(runtimeMode: RuntimeMode) {
  switch (runtimeMode) {
    case "approval-required":
      return {
        label: "Supervised",
        title: "Ask before commands and file changes",
        icon: LockIcon,
      };
    case "auto-accept-edits":
      return {
        label: "Auto-accept edits",
        title: "Auto-approve edits, ask before other actions",
        icon: PenLineIcon,
      };
    case "full-access":
      return {
        label: "Full access",
        title: "Allow commands and edits without prompts",
        icon: LockOpenIcon,
      };
  }
}

type ModelOptionsByProvider = ComponentProps<typeof ProviderModelPicker>["modelOptionsByProvider"];
interface ComposerFooterLeadingProps {
  isComposerFooterCompact: boolean;
  selectedProvider: ProviderKind;
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ProviderKind | null;
  providerStatuses: readonly ServerProvider[];
  modelOptionsByProvider: ModelOptionsByProvider;
  composerProviderState: {
    modelPickerIconClassName?: string;
  };
  hasThreadStarted: boolean;
  activePlan: boolean;
  sidebarProposedPlan: boolean;
  planSidebarOpen: boolean;
  planSidebarLabel: string;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  providerTraitsPicker: React.ReactNode;
  providerTraitsMenuContent: React.ReactNode;
  onProviderModelSelect: (provider: ProviderKind, model: string, subProviderID?: string) => void;
  onProviderUnlock: () => void;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}

export const ComposerFooterLeading = forwardRef<HTMLDivElement, ComposerFooterLeadingProps>(
  function ComposerFooterLeading(
    {
      isComposerFooterCompact,
      selectedProvider,
      selectedModelForPickerWithCustomFallback,
      lockedProvider,
      providerStatuses,
      modelOptionsByProvider,
      composerProviderState,
      hasThreadStarted,
      activePlan,
      sidebarProposedPlan,
      planSidebarOpen,
      planSidebarLabel,
      interactionMode,
      runtimeMode,
      providerTraitsPicker,
      providerTraitsMenuContent,
      onProviderModelSelect,
      onProviderUnlock,
      onToggleInteractionMode,
      onTogglePlanSidebar,
      onRuntimeModeChange,
    }: ComposerFooterLeadingProps,
    ref,
  ) {
    const runtimeModeOption = runtimeModeMeta(runtimeMode);
    const RuntimeModeIcon = runtimeModeOption.icon;

    return (
      <div
        ref={ref}
        className={cn(
          "-m-1 flex min-w-0 flex-1 items-center p-1",
          isComposerFooterCompact
            ? "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            : "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
        )}
      >
        {/* Provider/model picker */}
        <ProviderModelPicker
          compact={isComposerFooterCompact}
          provider={selectedProvider}
          model={selectedModelForPickerWithCustomFallback}
          lockedProvider={lockedProvider}
          providers={providerStatuses}
          modelOptionsByProvider={modelOptionsByProvider}
          {...(composerProviderState.modelPickerIconClassName
            ? { activeProviderIconClassName: composerProviderState.modelPickerIconClassName }
            : {})}
          onProviderModelChange={onProviderModelSelect}
          {...(hasThreadStarted ? { onProviderUnlock } : {})}
        />

        {isComposerFooterCompact ? (
          <CompactComposerControlsMenu
            activePlan={Boolean(activePlan || sidebarProposedPlan || planSidebarOpen)}
            interactionMode={interactionMode}
            planSidebarOpen={planSidebarOpen}
            planSidebarLabel={planSidebarLabel}
            runtimeMode={runtimeMode}
            traitsMenuContent={providerTraitsMenuContent}
            onToggleInteractionMode={onToggleInteractionMode}
            onTogglePlanSidebar={onTogglePlanSidebar}
            onRuntimeModeChange={onRuntimeModeChange}
          />
        ) : (
          <>
            {providerTraitsPicker}

            <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

            <Button
              variant="ghost"
              className="shrink-0 whitespace-nowrap px-2 text-xs text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
              size="sm"
              type="button"
              onClick={onToggleInteractionMode}
              title={
                interactionMode === "plan"
                  ? "Plan mode — click to return to normal build mode"
                  : "Default mode — click to enter plan mode"
              }
            >
              <BotIcon />
              <span className="sr-only sm:not-sr-only">
                {interactionMode === "plan" ? "Plan" : "Build"}
              </span>
            </Button>

            <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

            <Button
              variant="ghost"
              className="shrink-0 whitespace-nowrap px-2 text-xs text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
              size="sm"
              type="button"
              onClick={() => {
                const next: Record<typeof runtimeMode, typeof runtimeMode> = {
                  "full-access": "approval-required",
                  "approval-required": "auto-accept-edits",
                  "auto-accept-edits": "full-access",
                };
                onRuntimeModeChange(next[runtimeMode]);
              }}
              title={runtimeModeOption.title}
            >
              <RuntimeModeIcon />
              <span className="sr-only sm:not-sr-only">{runtimeModeOption.label}</span>
            </Button>

            {activePlan || sidebarProposedPlan || planSidebarOpen ? (
              <>
                <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                <Button
                  variant="ghost"
                  className={cn(
                    "shrink-0 whitespace-nowrap px-2 sm:px-3 text-xs",
                    planSidebarOpen
                      ? "text-info-foreground hover:text-foreground"
                      : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  size="sm"
                  type="button"
                  onClick={onTogglePlanSidebar}
                  title={
                    planSidebarOpen
                      ? `Hide ${planSidebarLabel.toLowerCase()} sidebar`
                      : `Show ${planSidebarLabel.toLowerCase()} sidebar`
                  }
                >
                  <ListTodoIcon />
                  <span className="sr-only sm:not-sr-only">{planSidebarLabel}</span>
                </Button>
              </>
            ) : null}
          </>
        )}
      </div>
    );
  },
);
