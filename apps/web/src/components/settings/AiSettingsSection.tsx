import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { Equal } from "effect";
import { FULL_TEXT_GENERATION_PROVIDERS } from "@bigbud/shared/internalTextGeneration";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByProvider,
  resolveAppModelSelectionState,
} from "../../models/provider";
import { useServerProviders } from "../../rpc/serverState";
import { ProviderModelPicker } from "../chat/provider/ProviderModelPicker";
import { TraitsPicker } from "../chat/provider/TraitsPicker";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { PromptSuggestionSettingsRows } from "./AiSettingsSection.promptSuggestions";
import {
  selectTextGenerationModel,
  updateTextGenerationModelOptions,
} from "./AiSettingsSection.models";

export function AiSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenSubProvider =
    "subProviderID" in textGenerationModelSelection
      ? textGenerationModelSelection.subProviderID
      : undefined;
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
            tone="success"
            checked={settings.enableAssistantStreaming}
            onCheckedChange={(checked) =>
              updateSettings({ enableAssistantStreaming: Boolean(checked) })
            }
            aria-label="Stream replies"
          />
        }
      />

      <SettingsRow
        title="Stream thinking"
        description="Display provider thinking live as it arrives."
        resetAction={
          settings.enableThinkingStreaming !== DEFAULT_UNIFIED_SETTINGS.enableThinkingStreaming ? (
            <SettingResetButton
              label="stream thinking"
              onClick={() =>
                updateSettings({
                  enableThinkingStreaming: DEFAULT_UNIFIED_SETTINGS.enableThinkingStreaming,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            tone="success"
            checked={settings.enableThinkingStreaming}
            onCheckedChange={(checked) =>
              updateSettings({ enableThinkingStreaming: Boolean(checked) })
            }
            aria-label="Stream thinking"
          />
        }
      />

      <PromptSuggestionSettingsRows />

      <SettingsRow
        title="Text generation model"
        description={
          settings.textGenerationModelSelection
            ? "Try this model first for internal text generation, then the thread’s last successful model."
            : "No override. Thread generation waits for a successful chat model; Git text without a thread needs an explicit model."
        }
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
              model={textGenSubProvider ? `${textGenModel}::${textGenSubProvider}` : textGenModel}
              allowedProviders={FULL_TEXT_GENERATION_PROVIDERS}
              lockedProvider={null}
              providers={serverProviders}
              modelOptionsByProvider={gitModelOptionsByProvider}
              triggerVariant="outline"
              triggerLabel={settings.textGenerationModelSelection ? undefined : "No override"}
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onProviderModelChange={(provider, model, subProviderID) => {
                updateSettings({
                  textGenerationModelSelection: resolveAppModelSelectionState(
                    {
                      ...settings,
                      textGenerationModelSelection: selectTextGenerationModel(
                        provider,
                        model,
                        subProviderID,
                      ),
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
              subProviderID={textGenSubProvider}
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
                      textGenerationModelSelection: updateTextGenerationModelOptions(
                        textGenerationModelSelection,
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
