import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

export function NotificationsSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
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
  );
}
