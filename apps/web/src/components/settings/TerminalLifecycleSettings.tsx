import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { isWindowsPlatform } from "../../lib/utils";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export const KEEP_TERMINALS_RUNNING_TITLE = "Keep terminals running after quitting";
const KEEP_TERMINALS_RUNNING_DESCRIPTION =
  "Terminals keep running in the background when you quit bigbud and reconnect the next time you open it. Idle terminals still close after 10 minutes.";
const WINDOWS_UNAVAILABLE_DESCRIPTION = "Not available on Windows yet.";

/** Whether quitting bigbud closes its terminals (the default) or leaves them running. */
export function TerminalLifecycleSettings({
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
}: {
  readonly platform?: string;
}) {
  const keepRunning = useSettings((settings) => settings.terminalsKeepRunningAfterQuit);
  const { updateSettings } = useUpdateSettings();
  const unavailable = isWindowsPlatform(platform);
  return (
    <SettingsRow
      title={KEEP_TERMINALS_RUNNING_TITLE}
      description={
        unavailable
          ? `${KEEP_TERMINALS_RUNNING_DESCRIPTION} ${WINDOWS_UNAVAILABLE_DESCRIPTION}`
          : KEEP_TERMINALS_RUNNING_DESCRIPTION
      }
      searchTerms={["quit", "background", "keep running", "reconnect", "close terminals"]}
      control={
        <Switch
          tone="success"
          checked={unavailable ? false : keepRunning}
          disabled={unavailable}
          onCheckedChange={(checked) =>
            updateSettings({ terminalsKeepRunningAfterQuit: Boolean(checked) })
          }
          aria-label={KEEP_TERMINALS_RUNNING_TITLE}
        />
      }
    />
  );
}
