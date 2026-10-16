import { ArrowUpRightIcon, ChevronDownIcon, LoaderIcon, PlusIcon } from "lucide-react";
import { type ReactNode, type RefObject } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderModel,
  type ThreadId,
} from "@bigbud/contracts";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingResetButton } from "./settingsLayout";
import { ProviderModelList } from "./ProviderCard.modelList";
import { ProviderModelCatalog } from "./ProviderCard.modelCatalog";
import { ProviderNativeTrust } from "./ProviderCard.nativeTrust";
import { ProviderThreadToolsSetup } from "./ProviderThreadToolsSetup";
import { ProviderNativeStatus } from "./ProviderCard.nativeStatus";
import { ClaudeSubagentCapsSettings } from "./ProviderCard.claudeSubagentCaps";
import type { OpenCodeSettingsStatus } from "./ProvidersSettingsSection.opencode";

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
  nativeStatus?: OpenCodeSettingsStatus | undefined;
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
  nativeServiceConsented?: boolean;
  onNativeServiceConsentChange?: (enabled: boolean) => void;
  serviceFile?: string;
  onServiceFileChange?: (file: string) => void;
  nativePluginConfigRoot?: string;
  onNativePluginConfigRootChange?: (root: string) => Promise<void>;
  nativeSetupRequest?: number;
  setupThreadId?: ThreadId | undefined;
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
  nativeServiceConsented = false,
  onNativeServiceConsentChange,
  serviceFile = "",
  onServiceFileChange,
  nativePluginConfigRoot = "",
  onNativePluginConfigRootChange,
  nativeSetupRequest = 0,
  setupThreadId,
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
                {card.isDirty && card.provider !== "opencodeV2" ? (
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
              {card.nativeStatus?.attention ? (
                <span
                  className={cn(
                    "ml-2",
                    card.nativeStatus.attention.tone === "error"
                      ? "text-destructive"
                      : "text-warning",
                  )}
                >
                  {card.nativeStatus.attention.label}
                </span>
              ) : null}
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
              aria-expanded={isOpen}
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
            {card.nativeStatus ? <ProviderNativeStatus status={card.nativeStatus} /> : null}
            {card.provider === "opencodeV2" && connectionMode === "isolated" ? (
              <div className="space-y-2 border-t border-border/60 px-4 py-3 text-sm sm:px-5">
                <p className="text-warning">
                  Retained isolated configuration is retired and read-only. Existing history will
                  not be migrated, recreated or replayed.
                </p>
                <Button variant="outline" onClick={() => onConnectionModeChange?.("shared")}>
                  Use shared native service for new chats
                </Button>
              </div>
            ) : null}
            {card.provider === "opencodeV2" && connectionMode === "shared" ? (
              <ProviderNativeTrust
                consented={nativeServiceConsented}
                onConsentChange={onNativeServiceConsentChange}
                serviceFile={serviceFile}
                onServiceFileChange={onServiceFileChange}
              />
            ) : null}
            {card.provider === "opencodeV2" && connectionMode === "shared" ? (
              <ProviderThreadToolsSetup
                consented={nativeServiceConsented}
                enabled={card.providerConfig.enabled}
                configRoot={nativePluginConfigRoot}
                onConfigRootChange={onNativePluginConfigRootChange}
                setupRequest={nativeSetupRequest}
                threadId={setupThreadId}
              />
            ) : null}
            {card.provider !== "opencodeV2" ? (
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
            ) : null}

            {card.provider === "claudeAgent" ? <ClaudeSubagentCapsSettings /> : null}

            {card.homePathKey && card.provider !== "opencodeV2" ? (
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

            {card.provider === "opencodeV2" ? (
              <ProviderModelCatalog
                models={card.models}
                modelListRef={modelListRef}
                onRemoveCustomModel={onRemoveCustomModel}
              />
            ) : (
              <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                <div className="text-xs font-medium text-foreground">Models</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {card.models.length} model
                  {card.models.length === 1 ? "" : "s"} available.
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
            )}
            {card.provider === "opencodeV2" && card.isDirty ? (
              <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
                <SettingResetButton
                  label={`${providerDisplayName} provider settings`}
                  onClick={onResetProvider}
                />
                Reset provider settings
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
