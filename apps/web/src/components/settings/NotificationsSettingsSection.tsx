import {
  CONTEXT_WINDOW_WARNING_THRESHOLD_MAX,
  CONTEXT_WINDOW_WARNING_THRESHOLD_MIN,
  DEFAULT_UNIFIED_SETTINGS,
} from "@bigbud/contracts/settings";
import { useCallback, useEffect, useState } from "react";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

export function NotificationsSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [warningThresholdDraft, setWarningThresholdDraft] = useState(
    String(settings.contextWindowWarningThresholdTokens),
  );

  useEffect(() => {
    setWarningThresholdDraft(String(settings.contextWindowWarningThresholdTokens));
  }, [settings.contextWindowWarningThresholdTokens]);

  const commitWarningThreshold = useCallback(() => {
    const parsed = Number(warningThresholdDraft);
    if (!Number.isFinite(parsed)) {
      setWarningThresholdDraft(String(settings.contextWindowWarningThresholdTokens));
      return;
    }

    const nextThreshold = Math.min(
      CONTEXT_WINDOW_WARNING_THRESHOLD_MAX,
      Math.max(CONTEXT_WINDOW_WARNING_THRESHOLD_MIN, Math.round(parsed)),
    );

    setWarningThresholdDraft(String(nextThreshold));
    if (nextThreshold !== settings.contextWindowWarningThresholdTokens) {
      updateSettings({ contextWindowWarningThresholdTokens: nextThreshold });
    }
  }, [settings.contextWindowWarningThresholdTokens, updateSettings, warningThresholdDraft]);

  return (
    <>
      <SettingsSection title="Notifications">
        <SettingsRow
          title="Task completion toasts"
          description="Show a toast when a task finishes while the app is in the background."
          resetAction={
            settings.enableTaskCompletionToasts !==
            DEFAULT_UNIFIED_SETTINGS.enableTaskCompletionToasts ? (
              <SettingResetButton
                label="task completion toasts"
                onClick={() =>
                  updateSettings({
                    enableTaskCompletionToasts: DEFAULT_UNIFIED_SETTINGS.enableTaskCompletionToasts,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableTaskCompletionToasts}
              onCheckedChange={(checked) =>
                updateSettings({ enableTaskCompletionToasts: Boolean(checked) })
              }
              aria-label="Enable task completion toasts"
            />
          }
        />

        <SettingsRow
          title="System notifications"
          description="Send an OS-level notification when a task completes, even when the app is in the background."
          resetAction={
            settings.enableSystemTaskCompletionNotifications !==
            DEFAULT_UNIFIED_SETTINGS.enableSystemTaskCompletionNotifications ? (
              <SettingResetButton
                label="system notifications"
                onClick={() =>
                  updateSettings({
                    enableSystemTaskCompletionNotifications:
                      DEFAULT_UNIFIED_SETTINGS.enableSystemTaskCompletionNotifications,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableSystemTaskCompletionNotifications}
              onCheckedChange={(checked) =>
                updateSettings({
                  enableSystemTaskCompletionNotifications: Boolean(checked),
                })
              }
              aria-label="Enable system task completion notifications"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Context Window Warnings">
        <SettingsRow
          title="Warning threshold"
          description="Choose when the context window warning appears. Applies to both the composer meter and the in-chat warning banner."
          status={`Minimum ${formatContextWindowTokens(CONTEXT_WINDOW_WARNING_THRESHOLD_MIN)} tokens, maximum ${formatContextWindowTokens(CONTEXT_WINDOW_WARNING_THRESHOLD_MAX)} tokens.`}
          resetAction={
            settings.contextWindowWarningThresholdTokens !==
            DEFAULT_UNIFIED_SETTINGS.contextWindowWarningThresholdTokens ? (
              <SettingResetButton
                label="context window warning threshold"
                onClick={() =>
                  updateSettings({
                    contextWindowWarningThresholdTokens:
                      DEFAULT_UNIFIED_SETTINGS.contextWindowWarningThresholdTokens,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-[172px]">
              <Input
                type="number"
                min={CONTEXT_WINDOW_WARNING_THRESHOLD_MIN}
                max={CONTEXT_WINDOW_WARNING_THRESHOLD_MAX}
                step={1_000}
                value={warningThresholdDraft}
                onChange={(event) => setWarningThresholdDraft(event.target.value)}
                onBlur={commitWarningThreshold}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                aria-label="Context window warning threshold in tokens"
              />
            </div>
          }
        />
      </SettingsSection>
    </>
  );
}
