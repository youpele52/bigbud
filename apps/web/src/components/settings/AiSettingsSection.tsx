import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { Equal } from "effect";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  createModelSelection,
  getCustomModelOptionsByProvider,
  resolveAppModelSelectionState,
} from "../../models/provider";
import { useServerProviders } from "../../rpc/serverState";
import { ProviderModelPicker } from "../chat/provider/ProviderModelPicker";
import { TraitsPicker } from "../chat/provider/TraitsPicker";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

export function AiSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    textGenProvider,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  return (
    <SettingsSection title="Text generation">
      <SettingsRow
        title="Stream replies"
        description="Display replies live as they arrive."
        resetAction={
          settings.enableAssistantStreaming !==
          DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
            <SettingResetButton
              label="stream replies"
              onClick={() =>
                updateSettings({
                  enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.enableAssistantStreaming}
            onCheckedChange={(checked) =>
              updateSettings({ enableAssistantStreaming: Boolean(checked) })
            }
            aria-label="Stream replies"
          />
        }
      />

      <SettingsRow
        title="Text generation model"
        description="Configure the model used for generated commit messages, PR titles, and similar Git text."
        resetAction={
          isGitWritingModelDirty ? (
            <SettingResetButton
              label="text generation model"
              onClick={() =>
                updateSettings({
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              provider={textGenProvider}
              model={textGenModel}
              lockedProvider={null}
              providers={serverProviders}
              modelOptionsByProvider={gitModelOptionsByProvider}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onProviderModelChange={(provider, model) => {
                updateSettings({
                  textGenerationModelSelection: resolveAppModelSelectionState(
                    {
                      ...settings,
                      textGenerationModelSelection: { provider, model },
                    },
                    serverProviders,
                  ),
                });
              }}
            />
            <TraitsPicker
              provider={textGenProvider}
              models={
                serverProviders.find((provider) => provider.provider === textGenProvider)?.models ??
                []
              }
              model={textGenModel}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={textGenModelOptions}
              allowPromptInjectedEffort={false}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onModelOptionsChange={(nextOptions) => {
                updateSettings({
                  textGenerationModelSelection: resolveAppModelSelectionState(
                    {
                      ...settings,
                      textGenerationModelSelection: createModelSelection(
                        textGenProvider,
                        textGenModel,
                        nextOptions,
                      ),
                    },
                    serverProviders,
                  ),
                });
              }}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
