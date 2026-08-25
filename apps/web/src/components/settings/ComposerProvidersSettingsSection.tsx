import { type ProviderKind } from "@bigbud/contracts";

import { PROVIDER_DESCRIPTORS } from "../chat/provider/providerDescriptors";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { isComposerProviderVisible } from "../../models/provider/composerVisibility.models";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

export function ComposerProvidersSettingsSection() {
  const hiddenComposerProviders = useSettings((settings) => settings.hiddenComposerProviders);
  const { updateSettings } = useUpdateSettings();

  function setProviderVisible(provider: ProviderKind, visible: boolean) {
    updateSettings({
      hiddenComposerProviders: visible
        ? hiddenComposerProviders.filter((candidate) => candidate !== provider)
        : [...hiddenComposerProviders, provider],
    });
  }

  return (
    <SettingsSection title="Provider visibility">
      <p className="mb-4 px-4 pt-4 text-xs text-muted-foreground sm:px-5">
        Choose which providers appear in the composer/provider and /model menus. This does not
        change provider setup or connection status.
      </p>
      {PROVIDER_DESCRIPTORS.map((descriptor) => {
        const visible = isComposerProviderVisible(descriptor.provider, hiddenComposerProviders);
        return (
          <SettingsRow
            key={descriptor.provider}
            title={descriptor.label}
            description="Show in the composer and /model menu."
            searchTerms={["provider", "composer", "model"]}
            resetAction={
              !visible ? (
                <SettingResetButton
                  label={`${descriptor.label} composer visibility`}
                  onClick={() => setProviderVisible(descriptor.provider, true)}
                />
              ) : undefined
            }
            control={
              <Switch
                tone="success"
                checked={visible}
                onCheckedChange={(checked) =>
                  setProviderVisible(descriptor.provider, Boolean(checked))
                }
                aria-label={`Show ${descriptor.label} in composer`}
              />
            }
          />
        );
      })}
    </SettingsSection>
  );
}
