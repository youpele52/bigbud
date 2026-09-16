import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { Separator } from "../../ui/separator";
import { Menu, MenuPopup, MenuTrigger } from "../../ui/menu";
import { cn } from "~/lib/utils";
import { getSelectedTraits, hasConfigurableTraits } from "./TraitsPicker.logic";
import { TraitsMenuContent } from "./TraitsPicker.menu";
import type { TraitsMenuContentProps, TraitsPersistence } from "./TraitsPicker.types";

export type { TraitsMenuContentProps } from "./TraitsPicker.types";
export { TraitsMenuContent } from "./TraitsPicker.menu";

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  models,
  model,
  subProviderID,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const traits = getSelectedTraits(
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
    subProviderID,
  );
  const {
    caps,
    effort,
    thinkingLevel,
    thinkingLevels,
    ultracodeEnabled,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    hasEffortOptions,
  } = traits;

  const effortLabel = effort
    ? (effortLevels.find((level) => level.value === effort)?.label ?? effort)
    : hasEffortOptions
      ? "Effort"
      : null;
  const thinkingLevelLabel =
    provider === "pi" && thinkingLevel
      ? {
          off: "Thinking Off",
          minimal: "Minimal",
          low: "Low",
          medium: "Medium",
          high: "High",
          xhigh: "Extra High",
        }[thinkingLevel]
      : provider === "pi" && thinkingLevels.length > 0
        ? "Pi default"
        : null;
  const contextWindowLabel =
    contextWindowOptions.length > 1 && contextWindow !== defaultContextWindow
      ? (contextWindowOptions.find((option) => option.value === contextWindow)?.label ?? null)
      : null;
  const triggerLabel = [
    provider === "pi" ? thinkingLevelLabel : null,
    ultrathinkPromptControlled
      ? "Ultrathink"
      : effortLabel
        ? effortLabel
        : thinkingEnabled === null
          ? null
          : `Thinking ${thinkingEnabled ? "On" : "Off"}`,
    ...(caps.supportsFastMode && fastModeEnabled ? ["Fast"] : []),
    ...(ultracodeEnabled ? ["Ultracode"] : []),
    ...(contextWindowLabel ? [contextWindowLabel] : []),
  ]
    .filter(Boolean)
    .join(" · ");

  const isCodexStyle = provider !== "claudeAgent";

  if (!hasConfigurableTraits(traits)) {
    return null;
  }

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Menu
        open={isMenuOpen}
        onOpenChange={(open) => {
          setIsMenuOpen(open);
        }}
      >
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant={triggerVariant ?? "ghost"}
              className={cn(
                isCodexStyle
                  ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
                  : "shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
                triggerClassName,
              )}
            />
          }
        >
          {isCodexStyle ? (
            <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
              {triggerLabel}
              <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
            </span>
          ) : (
            <>
              <span>{triggerLabel}</span>
              <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
            </>
          )}
        </MenuTrigger>
        <MenuPopup align="start">
          <TraitsMenuContent
            provider={provider}
            models={models}
            model={model}
            subProviderID={subProviderID}
            prompt={prompt}
            onPromptChange={onPromptChange}
            modelOptions={modelOptions}
            allowPromptInjectedEffort={allowPromptInjectedEffort}
            {...persistence}
          />
        </MenuPopup>
      </Menu>
    </>
  );
});
