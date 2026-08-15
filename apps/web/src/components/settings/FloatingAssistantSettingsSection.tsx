import { type ProviderKind } from "@bigbud/contracts";
import { useEffect, useMemo, useState } from "react";

import { ProviderModelPicker } from "~/components/chat/provider/ProviderModelPicker";
import { PROVIDER_DESCRIPTORS } from "~/components/chat/provider/providerDescriptors";
import { getProviderModels } from "~/models/provider";
import {
  COMPACT_CHAT_MODEL_PREFERENCE_STORAGE_KEY,
  CompactChatModelPreference,
  type CompactChatModelPreference as CompactChatModelPreferenceValue,
} from "~/models/compactChatModelPreference";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useServerProviders } from "~/rpc/serverState";

import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const EMPTY_PROVIDERS: ReturnType<typeof useServerProviders> = [];

export function FloatingAssistantSettingsSection() {
  const bridge = window.desktopBridge;
  const [enabled, setEnabled] = useState(false);
  const providers = useServerProviders() ?? EMPTY_PROVIDERS;
  const [modelPreference, setModelPreference] = useLocalStorage(
    COMPACT_CHAT_MODEL_PREFERENCE_STORAGE_KEY,
    null,
    CompactChatModelPreference,
  );
  const modelOptionsByProvider = useMemo(
    () =>
      Object.fromEntries(
        PROVIDER_DESCRIPTORS.map((descriptor) => [
          descriptor.provider,
          getProviderModels(providers, descriptor.provider),
        ]),
      ) as Record<ProviderKind, ReturnType<typeof getProviderModels>>,
    [providers],
  );
  const selectedProvider =
    modelPreference?.provider ??
    providers.find((provider) => provider.enabled)?.provider ??
    "codex";
  const selectedModel =
    modelPreference?.model ?? modelOptionsByProvider[selectedProvider][0]?.slug ?? "";

  useEffect(() => {
    if (!bridge?.getFloatingAssistantEnabled) return;
    void bridge.getFloatingAssistantEnabled().then(setEnabled);
  }, [bridge]);

  if (!bridge?.setFloatingAssistantEnabled) return null;
  return (
    <SettingsSection title="Floating assistant">
      <SettingsRow
        title="Enable floating assistant"
        description="Keeps bigbud running after the main window closes. Quit bigbud stops active local work."
        control={
          <Switch
            checked={enabled}
            aria-label="Enable floating assistant"
            onCheckedChange={(checked) => {
              const next = Boolean(checked);
              const update = bridge.setFloatingAssistantEnabled;
              if (!update) return;
              void update(next).then((updated) => {
                if (updated) setEnabled(next);
              });
            }}
          />
        }
      />
      <SettingsRow
        title="Floating chat model"
        description="Optional. When unset, new floating chats use your most recently submitted model."
        resetAction={
          modelPreference ? (
            <SettingResetButton
              label="floating chat model"
              onClick={() => setModelPreference(null)}
            />
          ) : null
        }
        control={
          <ProviderModelPicker
            compact
            provider={selectedProvider}
            model={selectedModel}
            lockedProvider={null}
            providers={providers}
            modelOptionsByProvider={modelOptionsByProvider}
            enableRecentlyUsed
            onProviderModelChange={(provider, model, subProviderID) => {
              setModelPreference({
                provider,
                model,
                ...(subProviderID ? { subProviderID } : {}),
                lastUsedAt: new Date().toISOString(),
              } satisfies CompactChatModelPreferenceValue);
            }}
          />
        }
      />
    </SettingsSection>
  );
}
