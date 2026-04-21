import {
  DEFAULT_UNIFIED_SETTINGS,
  TERMINAL_FONT_FAMILIES,
  TERMINAL_FONT_SIZES,
  type TerminalFontFamily,
} from "@bigbud/contracts/settings";
import { Equal } from "effect";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByProvider,
  resolveAppModelSelectionState,
} from "../../models/provider";
import { createModelSelection } from "../../models/provider";
import { useServerProviders } from "../../rpc/serverState";
import { ProviderModelPicker } from "../chat/provider/ProviderModelPicker";
import { TraitsPicker } from "../chat/provider/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useTheme } from "../../hooks/useTheme";
import { Input } from "../ui/input";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const TERMINAL_FONT_OPTIONS: Array<{ value: TerminalFontFamily; label: string }> = [
  {
    value: TERMINAL_FONT_FAMILIES[0],
    label: "Meslo Nerd Font Mono",
  },
  {
    value: TERMINAL_FONT_FAMILIES[1],
    label: "System monospace",
  },
];

export function GeneralSettingsSection() {
  const { theme, setTheme } = useTheme();
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
    <SettingsSection title="General">
      <SettingsRow
        title="Theme"
        description="Choose how bigbud looks across the app."
        resetAction={
          theme !== "system" ? (
            <SettingResetButton label="theme" onClick={() => setTheme("system")} />
          ) : null
        }
        control={
          <Select
            value={theme}
            onValueChange={(value) => {
              if (value === "system" || value === "light" || value === "dark") {
                setTheme(value);
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
              <SelectValue>
                {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {THEME_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Time format"
        description="System default follows your browser or OS clock preference."
        resetAction={
          settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
            <SettingResetButton
              label="time format"
              onClick={() =>
                updateSettings({
                  timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.timestampFormat}
            onValueChange={(value) => {
              if (value === "locale" || value === "12-hour" || value === "24-hour") {
                updateSettings({ timestampFormat: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
              <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="locale">
                {TIMESTAMP_FORMAT_LABELS.locale}
              </SelectItem>
              <SelectItem hideIndicator value="12-hour">
                {TIMESTAMP_FORMAT_LABELS["12-hour"]}
              </SelectItem>
              <SelectItem hideIndicator value="24-hour">
                {TIMESTAMP_FORMAT_LABELS["24-hour"]}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Terminal font"
        description="Use the bundled Meslo Nerd Font by default so prompt icons render correctly in the built-in terminal."
        resetAction={
          settings.terminalFontFamily !== DEFAULT_UNIFIED_SETTINGS.terminalFontFamily ? (
            <SettingResetButton
              label="terminal font"
              onClick={() =>
                updateSettings({
                  terminalFontFamily: DEFAULT_UNIFIED_SETTINGS.terminalFontFamily,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.terminalFontFamily}
            onValueChange={(value) => {
              if (value === TERMINAL_FONT_FAMILIES[0] || value === TERMINAL_FONT_FAMILIES[1]) {
                updateSettings({ terminalFontFamily: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Terminal font family">
              <SelectValue>
                {TERMINAL_FONT_OPTIONS.find(
                  (option) => option.value === settings.terminalFontFamily,
                )?.label ?? "Meslo Nerd Font Mono"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {TERMINAL_FONT_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Terminal font size"
        description="Tune the built-in terminal density without changing the rest of the app typography."
        resetAction={
          settings.terminalFontSize !== DEFAULT_UNIFIED_SETTINGS.terminalFontSize ? (
            <SettingResetButton
              label="terminal font size"
              onClick={() =>
                updateSettings({
                  terminalFontSize: DEFAULT_UNIFIED_SETTINGS.terminalFontSize,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={String(settings.terminalFontSize)}
            onValueChange={(value) => {
              const nextFontSize = Number(value);
              if (
                Number.isInteger(nextFontSize) &&
                TERMINAL_FONT_SIZES.includes(nextFontSize as (typeof TERMINAL_FONT_SIZES)[number])
              ) {
                updateSettings({ terminalFontSize: nextFontSize });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-32" aria-label="Terminal font size">
              <SelectValue>{`${settings.terminalFontSize}px`}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {TERMINAL_FONT_SIZES.map((fontSize) => (
                <SelectItem hideIndicator key={fontSize} value={String(fontSize)}>
                  {fontSize}px
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Diff line wrapping"
        description="Set the default wrap state when the diff panel opens."
        resetAction={
          settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
            <SettingResetButton
              label="diff line wrapping"
              onClick={() =>
                updateSettings({
                  diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.diffWordWrap}
            onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
            aria-label="Wrap diff lines by default"
          />
        }
      />

      <SettingsRow
        title="Assistant output"
        description="Show token-by-token output while a response is in progress."
        resetAction={
          settings.enableAssistantStreaming !==
          DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
            <SettingResetButton
              label="assistant output"
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
            aria-label="Stream assistant messages"
          />
        }
      />

      <SettingsRow
        title="New threads"
        description="Pick the default workspace mode for newly created draft threads."
        resetAction={
          settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
            <SettingResetButton
              label="new threads"
              onClick={() =>
                updateSettings({
                  defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.defaultThreadEnvMode}
            onValueChange={(value) => {
              if (value === "local" || value === "worktree") {
                updateSettings({ defaultThreadEnvMode: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
              <SelectValue>
                {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="local">
                Local
              </SelectItem>
              <SelectItem hideIndicator value="worktree">
                New worktree
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Default chat folder"
        description="Used as the working directory for chats in the Chats section when they are not tied to a project folder."
        resetAction={
          settings.defaultChatCwd !== DEFAULT_UNIFIED_SETTINGS.defaultChatCwd ? (
            <SettingResetButton
              label="default chat folder"
              onClick={() =>
                updateSettings({
                  defaultChatCwd: DEFAULT_UNIFIED_SETTINGS.defaultChatCwd,
                })
              }
            />
          ) : null
        }
        control={
          <Input
            value={settings.defaultChatCwd}
            onChange={(event) => updateSettings({ defaultChatCwd: event.target.value })}
            aria-label="Default chat folder"
            className="w-full sm:w-64"
            placeholder="~/Documents"
          />
        }
      />

      <SettingsRow
        title="Archive confirmation"
        description="Require a second click on the inline archive action before a thread is archived."
        resetAction={
          settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
            <SettingResetButton
              label="archive confirmation"
              onClick={() =>
                updateSettings({
                  confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.confirmThreadArchive}
            onCheckedChange={(checked) =>
              updateSettings({ confirmThreadArchive: Boolean(checked) })
            }
            aria-label="Confirm thread archiving"
          />
        }
      />

      <SettingsRow
        title="Delete confirmation"
        description="Ask before deleting a thread and its chat history."
        resetAction={
          settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
            <SettingResetButton
              label="delete confirmation"
              onClick={() =>
                updateSettings({
                  confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.confirmThreadDelete}
            onCheckedChange={(checked) => updateSettings({ confirmThreadDelete: Boolean(checked) })}
            aria-label="Confirm thread deletion"
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
