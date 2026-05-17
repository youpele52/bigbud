import { LoaderIcon, RefreshCwIcon } from "lucide-react";
import { type ProviderKind } from "@bigbud/contracts";
import { useCallback, useMemo, useRef, useState } from "react";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useServerProviders } from "../../rpc/serverState";
import { SettingsSection } from "./settingsLayout";
import { ProviderCard } from "./ProviderCard";
import { ProviderLastChecked } from "./ProvidersSettingsSection.lastChecked";
import {
  buildProviderCards,
  createInitialCustomModelInputs,
  createInitialOpenProviderDetails,
  getAddCustomModelError,
  getLatestProviderCheckedAt,
  shouldClearTextGenerationSelection,
} from "./ProvidersSettingsSection.logic";

export function ProvidersSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();

  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>(
    () => createInitialOpenProviderDetails(settings),
  );
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >(() => createInitialCustomModelInputs());
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});

  const codexHomePath = settings.providers.codex.homePath;

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
      const { normalized, error } = getAddCustomModelError({
        provider,
        rawInput: customModelInput,
        customModels,
        serverProviders,
      });
      if (!normalized) {
        setCustomModelErrorByProvider((prev) => ({ ...prev, [provider]: error }));
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

  const providerCards = useMemo(
    () => buildProviderCards({ serverProviders, settings }),
    [serverProviders, settings],
  );

  const lastCheckedAt = getLatestProviderCheckedAt(serverProviders);

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
              const shouldClearModelSelection = shouldClearTextGenerationSelection({
                settings,
                serverProviders,
                provider: card.provider,
                checked: Boolean(checked),
              });
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
