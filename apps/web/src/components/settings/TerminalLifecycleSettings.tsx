import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { isWindowsPlatform } from "../../lib/utils";
import { useServerTerminalHostEnabled } from "../../rpc/serverState";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export const KEEP_TERMINALS_RUNNING_TITLE = "Keep terminals running after quitting";
const KEEP_TERMINALS_RUNNING_DESCRIPTION =
  "Terminals keep running in the background when you quit bigbud and reconnect the next time you open it. Idle terminals still close after 10 minutes.";
const WINDOWS_UNAVAILABLE_DESCRIPTION = "Not available on Windows yet.";
const TERMINAL_HOST_OFF_DESCRIPTION = "Available when the background terminal host is enabled.";

/** Whether quitting bigbud closes its terminals (the default) or leaves them running. */
export function TerminalLifecycleSettings({
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
}: {
  readonly platform?: string;
}) {
  const keepRunning = useSettings((settings) => settings.terminalsKeepRunningAfterQuit);
  const { updateSettings } = useUpdateSettings();
  // The setting only acts on terminals in the background host; without it quitting always closes.
  const hostEnabled = useServerTerminalHostEnabled();
  const unavailableReason = isWindowsPlatform(platform)
    ? WINDOWS_UNAVAILABLE_DESCRIPTION
    : hostEnabled
      ? null
      : TERMINAL_HOST_OFF_DESCRIPTION;
  const unavailable = unavailableReason !== null;
  return (
    <SettingsRow
      title={KEEP_TERMINALS_RUNNING_TITLE}
      description={
        unavailable
          ? `${KEEP_TERMINALS_RUNNING_DESCRIPTION} ${unavailableReason}`
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
