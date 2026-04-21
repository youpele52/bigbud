import { LoaderIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@bigbud/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { normalizeModelSlug } from "@bigbud/shared/model";
import { Equal } from "effect";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { MAX_CUSTOM_MODEL_LENGTH, resolveAppModelSelectionState } from "../../models/provider";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useServerProviders } from "../../rpc/serverState";
import { formatRelativeTime } from "../../utils/timestamp";
import { SettingsSection } from "./settingsLayout";
import { ProviderCard, type ProviderCardData } from "./ProviderCard";

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: "copilot",
    title: "Copilot",
    binaryPlaceholder: "Copilot binary path",
    binaryDescription: "Path to the GitHub Copilot CLI binary",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: "Path to the OpenCode binary",
  },
  {
    provider: "pi",
    title: "Pi",
    binaryPlaceholder: "Pi binary path",
    binaryDescription: "Path to the Pi binary",
  },
  {
    provider: "cursor",
    title: "Cursor",
    binaryPlaceholder: "Cursor agent binary path",
    binaryDescription: "Path to the Cursor agent binary (agent CLI)",
  },
] as const;

const PROVIDER_STATUS_STYLES = {
  disabled: { dot: "bg-amber-400" },
  error: { dot: "bg-destructive" },
  ready: { dot: "bg-success" },
  warning: { dot: "bg-warning" },
} as const;

function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in bigbud.",
    };
  }
  if (!provider.installed) {
    return { headline: "Not found", detail: provider.message ?? "CLI not detected on PATH." };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return { headline: "Not authenticated", detail: provider.message ?? null };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

function useRelativeTimeTick(intervalMs = 1_000) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  const tick = useRelativeTimeTick(1_000);
  void tick;
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) return null;

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

export function ProvidersSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();

  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.customModels.length > 0,
    ),
    copilot: Boolean(
      settings.providers.copilot.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.copilot.binaryPath ||
      settings.providers.copilot.customModels.length > 0,
    ),
    opencode: Boolean(
      settings.providers.opencode.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.opencode.binaryPath ||
      settings.providers.opencode.customModels.length > 0,
    ),
    pi: Boolean(
      settings.providers.pi.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.pi.binaryPath ||
      settings.providers.pi.customModels.length > 0,
    ),
    cursor: Boolean(
      settings.providers.cursor.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.cursor.binaryPath ||
      settings.providers.cursor.customModels.length > 0,
    ),
  });
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({ codex: "", claudeAgent: "", copilot: "", opencode: "", pi: "", cursor: "" });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});

  const codexHomePath = settings.providers.codex.homePath;
  const textGenProvider = resolveAppModelSelectionState(settings, serverProviders).provider;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureNativeApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = settings.providers[provider].customModels;
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((prev) => ({ ...prev, [provider]: "Enter a model slug." }));
        return;
      }
      if (
        serverProviders
          .find((c) => c.provider === provider)
          ?.models.some((o) => !o.isCustom && o.slug === normalized)
      ) {
        setCustomModelErrorByProvider((prev) => ({
          ...prev,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((prev) => ({
          ...prev,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((prev) => ({
          ...prev,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: [...customModels, normalized],
          },
        },
      });
      setCustomModelInputByProvider((prev) => ({ ...prev, [provider]: "" }));
      setCustomModelErrorByProvider((prev) => ({ ...prev, [provider]: null }));

      const el = modelListRefs.current[provider];
      if (!el) return;
      const scrollToEnd = () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      requestAnimationFrame(scrollToEnd);
      const observer = new MutationObserver(() => {
        scrollToEnd();
        observer.disconnect();
      });
      observer.observe(el, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 2_000);
    },
    [customModelInputByProvider, serverProviders, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: settings.providers[provider].customModels.filter((m) => m !== slug),
          },
        },
      });
      setCustomModelErrorByProvider((prev) => ({ ...prev, [provider]: null }));
    },
    [settings, updateSettings],
  );

  const providerCards = useMemo<ProviderCardData[]>(
    () =>
      PROVIDER_SETTINGS.map((providerSettings) => {
        const liveProvider = serverProviders.find((c) => c.provider === providerSettings.provider);
        const providerConfig = settings.providers[providerSettings.provider];
        const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
        const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
        const summary = getProviderSummary(liveProvider);
        const models: ReadonlyArray<ServerProviderModel> =
          liveProvider?.models ??
          providerConfig.customModels.map((slug) => ({
            slug,
            name: slug,
            isCustom: true,
            capabilities: null,
          }));

        return {
          provider: providerSettings.provider,
          title: providerSettings.title,
          binaryPlaceholder: providerSettings.binaryPlaceholder,
          binaryDescription: providerSettings.binaryDescription,
          homePathKey: providerSettings.homePathKey,
          homePlaceholder: providerSettings.homePlaceholder,
          homeDescription: providerSettings.homeDescription,
          binaryPathValue: providerConfig.binaryPath,
          isDirty: !Equal.equals(providerConfig, defaultProviderConfig),
          models,
          providerConfig,
          statusStyle: PROVIDER_STATUS_STYLES[statusKey],
          summary,
          versionLabel: getProviderVersionLabel(liveProvider?.version),
        };
      }),
    [serverProviders, settings.providers],
  );

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, p) => (p.checkedAt > latest ? p.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  return (
    <SettingsSection
      title="Providers"
      headerAction={
        <div className="flex items-center gap-1.5">
          <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={isRefreshingProviders}
                  onClick={() => void refreshProviders()}
                  aria-label="Refresh provider status"
                >
                  {isRefreshingProviders ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh provider status</TooltipPopup>
          </Tooltip>
        </div>
      }
    >
      {providerCards.map((card) => {
        const modelListRef = {
          get current() {
            return modelListRefs.current[card.provider] ?? null;
          },
          set current(el: HTMLDivElement | null) {
            modelListRefs.current[card.provider] = el;
          },
        };

        return (
          <ProviderCard
            key={card.provider}
            card={card}
            isOpen={openProviderDetails[card.provider]}
            codexHomePath={codexHomePath}
            customModelInput={customModelInputByProvider[card.provider]}
            customModelError={customModelErrorByProvider[card.provider] ?? null}
            modelListRef={modelListRef}
            onToggleOpen={() =>
              setOpenProviderDetails((prev) => ({
                ...prev,
                [card.provider]: !prev[card.provider],
              }))
            }
            onOpenChange={(open) =>
              setOpenProviderDetails((prev) => ({ ...prev, [card.provider]: open }))
            }
            onResetProvider={() => {
              updateSettings({
                providers: {
                  ...settings.providers,
                  [card.provider]: DEFAULT_UNIFIED_SETTINGS.providers[card.provider],
                },
              });
              setCustomModelErrorByProvider((prev) => ({ ...prev, [card.provider]: null }));
            }}
            onToggleEnabled={(checked) => {
              const isDisabling = !checked;
              const shouldClearModelSelection = isDisabling && textGenProvider === card.provider;
              updateSettings({
                providers: {
                  ...settings.providers,
                  [card.provider]: {
                    ...settings.providers[card.provider],
                    enabled: Boolean(checked),
                  },
                },
                ...(shouldClearModelSelection
                  ? {
                      textGenerationModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                    }
                  : {}),
              });
            }}
            onBinaryPathChange={(value) =>
              updateSettings({
                providers: {
                  ...settings.providers,
                  [card.provider]: { ...settings.providers[card.provider], binaryPath: value },
                },
              })
            }
            onHomePathChange={(value) =>
              updateSettings({
                providers: {
                  ...settings.providers,
                  codex: { ...settings.providers.codex, homePath: value },
                },
              })
            }
            onCustomModelInputChange={(value) => {
              setCustomModelInputByProvider((prev) => ({ ...prev, [card.provider]: value }));
              if (customModelErrorByProvider[card.provider]) {
                setCustomModelErrorByProvider((prev) => ({ ...prev, [card.provider]: null }));
              }
            }}
            onAddCustomModel={() => addCustomModel(card.provider)}
            onRemoveCustomModel={(slug) => removeCustomModel(card.provider, slug)}
          />
        );
      })}
    </SettingsSection>
  );
}
