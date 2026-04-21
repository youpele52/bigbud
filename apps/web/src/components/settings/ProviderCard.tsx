import { ChevronDownIcon, InfoIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, type RefObject } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderModel,
} from "@bigbud/contracts";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingResetButton } from "./settingsLayout";

export type ProviderCardData = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  homePathKey?: "codexHomePath" | undefined;
  homePlaceholder?: string | undefined;
  homeDescription?: ReactNode | undefined;
  binaryPathValue: string;
  isDirty: boolean;
  models: ReadonlyArray<ServerProviderModel>;
  providerConfig: { enabled: boolean };
  statusStyle: { dot: string };
  summary: { headline: string; detail: string | null };
  versionLabel: string | null;
};

type ProviderCardProps = {
  card: ProviderCardData;
  isOpen: boolean;
  codexHomePath: string;
  customModelInput: string;
  customModelError: string | null;
  modelListRef: RefObject<HTMLDivElement | null>;
  onToggleOpen: () => void;
  onOpenChange: (open: boolean) => void;
  onResetProvider: () => void;
  onToggleEnabled: (checked: boolean) => void;
  onBinaryPathChange: (value: string) => void;
  onHomePathChange: (value: string) => void;
  onCustomModelInputChange: (value: string) => void;
  onAddCustomModel: () => void;
  onRemoveCustomModel: (slug: string) => void;
};

export function ProviderCard({
  card,
  isOpen,
  codexHomePath,
  customModelInput,
  customModelError,
  modelListRef,
  onToggleOpen,
  onOpenChange,
  onResetProvider,
  onToggleEnabled,
  onBinaryPathChange,
  onHomePathChange,
  onCustomModelInputChange,
  onAddCustomModel,
  onRemoveCustomModel,
}: ProviderCardProps) {
  const providerDisplayName = PROVIDER_DISPLAY_NAMES[card.provider] ?? card.title;

  return (
    <div className="border-t border-border first:border-t-0">
      <div className="px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-h-5 items-center gap-1.5">
              <span className={cn("size-2 shrink-0 rounded-full", card.statusStyle.dot)} />
              <h3 className="text-sm font-medium text-foreground">{providerDisplayName}</h3>
              {card.versionLabel ? (
                <code className="text-xs text-muted-foreground">{card.versionLabel}</code>
              ) : null}
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                {card.isDirty ? (
                  <SettingResetButton
                    label={`${providerDisplayName} provider settings`}
                    onClick={onResetProvider}
                  />
                ) : null}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {card.summary.headline}
              {card.summary.detail ? ` - ${card.summary.detail}` : null}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={onToggleOpen}
              aria-label={`Toggle ${providerDisplayName} details`}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", isOpen && "rotate-180")}
              />
            </Button>
            <Switch
              checked={card.providerConfig.enabled}
              onCheckedChange={onToggleEnabled}
              aria-label={`Enable ${providerDisplayName}`}
            />
          </div>
        </div>
      </div>

      <Collapsible open={isOpen} onOpenChange={onOpenChange}>
        <CollapsibleContent>
          <div className="space-y-0">
            <div className="border-t border-border/60 px-4 py-3 sm:px-5">
              <label htmlFor={`provider-install-${card.provider}-binary-path`} className="block">
                <span className="text-xs font-medium text-foreground">
                  {providerDisplayName} binary path
                </span>
                <Input
                  id={`provider-install-${card.provider}-binary-path`}
                  className="mt-1.5"
                  value={card.binaryPathValue}
                  onChange={(event) => onBinaryPathChange(event.target.value)}
                  placeholder={card.binaryPlaceholder}
                  spellCheck={false}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  {card.binaryDescription}
                </span>
              </label>
            </div>

            {card.homePathKey ? (
              <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                <label htmlFor={`provider-install-${card.homePathKey}`} className="block">
                  <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                  <Input
                    id={`provider-install-${card.homePathKey}`}
                    className="mt-1.5"
                    value={codexHomePath}
                    onChange={(event) => onHomePathChange(event.target.value)}
                    placeholder={card.homePlaceholder}
                    spellCheck={false}
                  />
                  {card.homeDescription ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {card.homeDescription}
                    </span>
                  ) : null}
                </label>
              </div>
            ) : null}

            <div className="border-t border-border/60 px-4 py-3 sm:px-5">
              <div className="text-xs font-medium text-foreground">Models</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {card.models.length} model{card.models.length === 1 ? "" : "s"} available.
              </div>
              <div ref={modelListRef} className="mt-2 max-h-40 overflow-y-auto pb-1">
                {card.models.map((model) => {
                  const caps = model.capabilities;
                  const capLabels: string[] = [];
                  if (caps?.supportsFastMode) capLabels.push("Fast mode");
                  if (caps?.supportsThinkingToggle) capLabels.push("Thinking");
                  if (caps?.reasoningEffortLevels && caps.reasoningEffortLevels.length > 0) {
                    capLabels.push("Reasoning");
                  }
                  const hasDetails = capLabels.length > 0 || model.name !== model.slug;

                  return (
                    <div
                      key={`${card.provider}:${model.slug}`}
                      className="flex items-center gap-2 py-1"
                    >
                      <span className="min-w-0 truncate text-xs text-foreground/90">
                        {model.name}
                      </span>
                      {hasDetails ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                                aria-label={`Details for ${model.name}`}
                              />
                            }
                          >
                            <InfoIcon className="size-3" />
                          </TooltipTrigger>
                          <TooltipPopup side="top" className="max-w-56">
                            <div className="space-y-1">
                              <code className="block text-[11px] text-foreground">
                                {model.slug}
                              </code>
                              {capLabels.length > 0 ? (
                                <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                                  {capLabels.map((label) => (
                                    <span key={label} className="text-[10px] text-muted-foreground">
                                      {label}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </TooltipPopup>
                        </Tooltip>
                      ) : null}
                      {model.isCustom ? (
                        <div className="ml-auto flex shrink-0 items-center gap-1.5">
                          <span className="text-[10px] text-muted-foreground">custom</span>
                          <button
                            type="button"
                            className="text-muted-foreground transition-colors hover:text-foreground"
                            aria-label={`Remove ${model.slug}`}
                            onClick={() => onRemoveCustomModel(model.slug)}
                          >
                            <XIcon className="size-3" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input
                  id={`custom-model-${card.provider}`}
                  value={customModelInput}
                  onChange={(event) => onCustomModelInputChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    onAddCustomModel();
                  }}
                  placeholder={
                    card.provider === "codex" ? "gpt-6.7-codex-ultra-preview" : "claude-sonnet-5-0"
                  }
                  spellCheck={false}
                />
                <Button className="shrink-0" variant="outline" onClick={onAddCustomModel}>
                  <PlusIcon className="size-3.5" />
                  Add
                </Button>
              </div>

              {customModelError ? (
                <p className="mt-2 text-xs text-destructive">{customModelError}</p>
              ) : null}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
