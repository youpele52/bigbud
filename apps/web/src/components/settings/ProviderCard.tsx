import { ArrowUpRightIcon, ChevronDownIcon, LoaderIcon, PlusIcon } from "lucide-react";
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
import { SettingResetButton } from "./settingsLayout";
import { ProviderModelList } from "./ProviderCard.modelList";

export type ProviderCardData = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  configPath?: boolean | undefined;
  homePathKey?: "codexHomePath" | "opencodeV2ProfileRoot" | undefined;
  homePlaceholder?: string | undefined;
  homeDescription?: ReactNode | undefined;
  setupUrl?: string | undefined;
  supportsCustomModels: boolean;
  customModelPlaceholder?: string | undefined;
  binaryPathValue: string;
  configPathValue: string;
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
  onActivateCliProxy?: (() => void) | undefined;
  isActivatingCliProxy?: boolean | undefined;
  onBinaryPathChange: (value: string) => void;
  onConfigPathChange: (value: string) => void;
  onOpenSetupGuide: () => void;
  onHomePathChange: (value: string) => void;
  connectionMode?: "shared" | "isolated";
  onConnectionModeChange?: (mode: "shared" | "isolated") => void;
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
  onActivateCliProxy,
  isActivatingCliProxy = false,
  onBinaryPathChange,
  onConfigPathChange,
  onOpenSetupGuide,
  onHomePathChange,
  connectionMode = "shared",
  onConnectionModeChange,
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
                <span className="text-sm font-light text-muted-foreground">
                  {card.versionLabel}
                </span>
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
            {card.provider === "cliProxy" &&
            card.providerConfig.enabled &&
            card.summary.headline !== "Not found" &&
            card.models.length === 0 &&
            onActivateCliProxy ? (
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-7 px-2 text-xs"
                disabled={isActivatingCliProxy}
                onClick={onActivateCliProxy}
              >
                {isActivatingCliProxy ? <LoaderIcon className="size-3 animate-spin" /> : null}
                {isActivatingCliProxy ? "Starting..." : "Start / retry"}
              </Button>
            ) : null}
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
              tone="success"
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
            {card.provider === "opencodeV2" ? (
              <label className="block border-t border-border/60 px-4 py-3 text-xs sm:px-5">
                Connection mode
                <select
                  className="mt-1.5 block w-full rounded-md border border-border bg-background p-2 text-sm"
                  aria-label="OpenCode v2 connection mode"
                  value={connectionMode}
                  onChange={(event) =>
                    onConnectionModeChange?.(event.target.value as "shared" | "isolated")
                  }
                >
                  <option value="shared">Shared TUI service (recommended)</option>
                  <option value="isolated">Isolated profile (advanced)</option>
                </select>
              </label>
            ) : null}
            <div className="border-t border-border/60 px-4 py-3 sm:px-5">
              <label htmlFor={`provider-install-${card.provider}-binary-path`} className="block">
                <span className="text-xs font-medium text-foreground">
                  {card.configPath
                    ? "CLIProxyAPI config path"
                    : `${providerDisplayName} binary path`}
                </span>
                <Input
                  id={`provider-install-${card.provider}-binary-path`}
                  className="mt-1.5"
                  value={card.configPath ? card.configPathValue : card.binaryPathValue}
                  onChange={(event) =>
                    card.configPath
                      ? onConfigPathChange(event.target.value)
                      : onBinaryPathChange(event.target.value)
                  }
                  placeholder={card.binaryPlaceholder}
                  spellCheck={false}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  {card.binaryDescription}
                </span>
                {card.setupUrl ? (
                  <Button
                    className="mt-2 h-7 gap-1 px-2 text-xs"
                    variant="outline"
                    onClick={onOpenSetupGuide}
                  >
                    {providerDisplayName} setup guide
                    <ArrowUpRightIcon className="size-3" aria-hidden="true" />
                  </Button>
                ) : null}
              </label>
            </div>

            {card.homePathKey &&
            (card.provider !== "opencodeV2" || connectionMode === "isolated") ? (
              <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                <label htmlFor={`provider-install-${card.homePathKey}`} className="block">
                  <span className="text-xs font-medium text-foreground">
                    {card.provider === "opencodeV2"
                      ? "Dedicated V2 profile path"
                      : "CODEX_HOME path"}
                  </span>
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
              <ProviderModelList
                provider={card.provider}
                models={card.models}
                modelListRef={modelListRef}
                onRemoveCustomModel={onRemoveCustomModel}
              />

              {card.supportsCustomModels ? (
                <>
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
                      placeholder={card.customModelPlaceholder}
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
                </>
              ) : null}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
