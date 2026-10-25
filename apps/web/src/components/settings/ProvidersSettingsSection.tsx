import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import { type ProviderKind } from "@bigbud/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { hasOpencodeV2ManagedPluginTrust } from "@bigbud/shared/opencodeNativeTrust";
import { useUiStateStore } from "../../stores/ui/ui.store";
import { toastManager } from "../ui/toast";
import { RefreshIconButton } from "../ui/RefreshIconButton";
import { useServerProviders } from "../../rpc/serverState";
import { useCliProxyActivation } from "../../hooks/useCliProxyActivation";
import { SettingsSection } from "./settingsLayout";
import { ProviderCard } from "./ProviderCard";
import { ProviderLastChecked } from "./ProvidersSettingsSection.lastChecked";
import {
  buildProviderCards,
  createInitialCustomModelInputs,
  createInitialOpenProviderDetails,
  expandProviderDetails,
  getAddCustomModelError,
  getLatestProviderCheckedAt,
} from "./ProvidersSettingsSection.logic";

export function ProvidersSettingsSection({
  expandedProviders = [],
}: {
  readonly expandedProviders?: ReadonlyArray<ProviderKind>;
}) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const { activateCliProxy, isActivatingCliProxy } = useCliProxyActivation();

  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>(
    () => expandProviderDetails(createInitialOpenProviderDetails(settings), expandedProviders),
  );
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >(() => createInitialCustomModelInputs());
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [nativeSetupRequest, setNativeSetupRequest] = useState(0);
  const setupThreadId = useUiStateStore((state) => state.lastActiveThreadId) ?? undefined;
  const nativeConsentRequest = useRef(0);
  async function acknowledgeNativeSetup(enabled: boolean) {
    const request = ++nativeConsentRequest.current;
    try {
      const accepted = await ensureNativeApi().server.updateSettings({
        providers: {
          opencodeV2: {
            nativeServiceTrust: enabled ? "managed-thread-tools-v2" : null,
          },
        },
      });
      if (
        request === nativeConsentRequest.current &&
        enabled &&
        accepted.providers.opencodeV2.enabled &&
        hasOpencodeV2ManagedPluginTrust(accepted.providers.opencodeV2)
      )
        setNativeSetupRequest((value) => value + 1);
    } catch {
      toastManager.add({
        type: "error",
        title: "Native acknowledgement was not saved",
        description:
          "Required plugin setup has not been requested. Retry after checking the connection.",
      });
    }
  }
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});

  const codexHomePath = settings.providers.codex.homePath;

  useEffect(() => {
    if (expandedProviders.length === 0) return;
    setOpenProviderDetails((previous) => expandProviderDetails(previous, expandedProviders));
  }, [expandedProviders]);

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
      const providerSettings = settings.providers[provider];
      if (!("customModels" in providerSettings)) return;
      const customModels = providerSettings.customModels;
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
      const providerSettings = settings.providers[provider];
      if (!("customModels" in providerSettings)) return;
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: providerSettings.customModels.filter((m) => m !== slug),
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
          <RefreshIconButton
            label="Refresh provider status"
            busy={isRefreshingProviders}
            onClick={() => void refreshProviders()}
          />
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
            connectionMode={resolveOpencodeV2ConnectionMode(settings.providers.opencodeV2)}
            onConnectionModeChange={(connectionMode) =>
              updateSettings({
                providers: {
                  ...settings.providers,
                  opencodeV2: {
                    ...settings.providers.opencodeV2,
                    connectionMode,
                    nativeServiceTrust: null,
                  },
                },
              })
            }
            nativeServiceConsented={hasOpencodeV2ManagedPluginTrust(settings.providers.opencodeV2)}
            onNativeServiceConsentChange={(enabled) => void acknowledgeNativeSetup(enabled)}
            nativeSetupRequest={nativeSetupRequest}
            setupThreadId={setupThreadId}
            nativePluginConfigRoot={settings.providers.opencodeV2.nativePluginConfigRoot ?? ""}
            onNativePluginConfigRootChange={async (nativePluginConfigRoot) => {
              nativeConsentRequest.current++;
              await ensureNativeApi().server.updateSettings({
                providers: { opencodeV2: { nativePluginConfigRoot } },
              });
            }}
            serviceFile={settings.providers.opencodeV2.serviceFile ?? ""}
            onServiceFileChange={(serviceFile) =>
              updateSettings({
                providers: {
                  ...settings.providers,
                  opencodeV2: {
                    ...settings.providers.opencodeV2,
                    serviceFile,
                    nativeServiceTrust: null,
                  },
                },
              })
            }
            isOpen={openProviderDetails[card.provider]}
            codexHomePath={
              card.provider === "opencodeV2"
                ? settings.providers.opencodeV2.profileRoot
                : codexHomePath
            }
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
                  [card.provider]: {
                    ...DEFAULT_UNIFIED_SETTINGS.providers[card.provider],
                    ...(card.provider === "opencodeV2"
                      ? {
                          ...settings.providers.opencodeV2,
                          enabled: DEFAULT_UNIFIED_SETTINGS.providers.opencodeV2.enabled,
                          nativeServiceTrust: null,
                        }
                      : {}),
                  },
                },
              });
              setCustomModelErrorByProvider((prev) => ({ ...prev, [card.provider]: null }));
            }}
            onActivateCliProxy={
              card.provider === "cliProxy" ? () => void activateCliProxy() : undefined
            }
            isActivatingCliProxy={card.provider === "cliProxy" ? isActivatingCliProxy : false}
            onToggleEnabled={(checked) => {
              if (
                card.provider === "opencodeV2" &&
                checked &&
                hasOpencodeV2ManagedPluginTrust(settings.providers.opencodeV2)
              ) {
                void ensureNativeApi()
                  .server.updateSettings({ providers: { opencodeV2: { enabled: true } } })
                  .then((accepted) => {
                    if (hasOpencodeV2ManagedPluginTrust(accepted.providers.opencodeV2))
                      setNativeSetupRequest((value) => value + 1);
                  })
                  .catch(() =>
                    toastManager.add({
                      type: "error",
                      title: "OpenCode v2 was not enabled",
                      description: "Required plugin setup has not been requested.",
                    }),
                  );
                return;
              }
              updateSettings({
                providers: {
                  ...settings.providers,
                  [card.provider]: {
                    ...settings.providers[card.provider],
                    enabled: Boolean(checked),
                  },
                },
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
            onConfigPathChange={(value) =>
              updateSettings({
                providers: {
                  ...settings.providers,
                  cliProxy: { ...settings.providers.cliProxy, configPath: value },
                },
              })
            }
            onOpenSetupGuide={() => {
              void ensureNativeApi()
                .shell.openExternal("https://help.router-for.me/introduction/quick-start.html")
                .catch((error: unknown) =>
                  console.warn("Failed to open CLIProxyAPI setup guide", error),
                );
            }}
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
