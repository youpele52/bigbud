import { type ProviderKind } from "@bigbud/contracts";
import type { FloatingAssistantCaller } from "@bigbud/contracts/server/ipc.ts";
import { useEffect, useMemo, useState } from "react";

import { ProviderModelPicker } from "~/components/chat/provider/ProviderModelPicker";
import { PROVIDER_DESCRIPTORS } from "~/components/chat/provider/providerDescriptors";
import { MASCOT_ANIMATIONS } from "~/components/floating-assistant/mascotAssets";
import { BigbudLogo } from "~/components/sidebar/SidebarProjectItem";
import { Radio, RadioGroup } from "~/components/ui/radio-group";
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
  const [enabled, setEnabled] = useState(true);
  const [caller, setCaller] = useState<FloatingAssistantCaller>("matte");
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

  useEffect(() => {
    if (!bridge?.getFloatingAssistantCaller) return;
    void bridge.getFloatingAssistantCaller().then(setCaller);
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
      <SettingsRow
        title="Floating chat caller"
        description="Choose the button that opens floating chat. Matte black is the default."
      >
        <RadioGroup
          value={caller}
          className="mt-3 grid gap-2 sm:grid-cols-3"
          onValueChange={(value) => {
            if (value !== "chrome" && value !== "logo" && value !== "matte") return;
            const update = bridge?.setFloatingAssistantCaller;
            if (!update) return;
            const previous = caller;
            setCaller(value);
            void update(value).then((updated) => {
              if (!updated) setCaller(previous);
            });
          }}
        >
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/70 px-3 py-2.5">
            <Radio value="logo" />
            <BigbudLogo className="h-4" />
            <span className="text-sm font-medium">bigbud logo</span>
          </label>
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/70 px-3 py-2.5">
            <Radio value="matte" />
            <img src={MASCOT_ANIMATIONS.matte.okay} alt="" className="size-8 object-contain" />
            <span className="text-sm font-medium">Matte black</span>
          </label>
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/70 px-3 py-2.5">
            <Radio value="chrome" />
            <img src={MASCOT_ANIMATIONS.chrome.okay} alt="" className="size-8 object-contain" />
            <span className="text-sm font-medium">Chrome</span>
          </label>
        </RadioGroup>
      </SettingsRow>
    </SettingsSection>
  );
}
