import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { isWindowsPlatform } from "../../lib/utils";
import {
  useServerTerminalHostControlledByEnvironment,
  useServerTerminalHostEnabled,
} from "../../rpc/serverState";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export const TERMINAL_HOST_TITLE = "Run terminals in the background host (preview)";
const TERMINAL_HOST_DESCRIPTION =
  "Local and Direct SSH terminals run in a small background helper, so they survive a backend restart with the same programs and screen. Up to 24 terminals stay open, and idle shells you can't see close after 10 minutes.";
export const TERMINAL_HOST_RESTART_NOTE = "Restart bigbud to apply.";
export const TERMINAL_HOST_ENVIRONMENT_NOTE =
  "Set by BIGBUD_TERMINAL_HOST for this launch; otherwise this toggle decides.";
const WINDOWS_UNAVAILABLE_NOTE = "Not available on Windows yet.";

/** Opts new local terminals into the background terminal host. Read at startup, so a change applies after a restart. */
export function TerminalHostSettings({
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
}: {
  readonly platform?: string;
}) {
  const saved = useSettings((settings) => settings.terminalHostEnabled);
  const { updateSettings } = useUpdateSettings();
  const running = useServerTerminalHostEnabled();
  const controlledByEnvironment = useServerTerminalHostControlledByEnvironment();
  const windows = isWindowsPlatform(platform);
  const note = windows
    ? WINDOWS_UNAVAILABLE_NOTE
    : controlledByEnvironment
      ? TERMINAL_HOST_ENVIRONMENT_NOTE
      : saved !== running
        ? TERMINAL_HOST_RESTART_NOTE
        : null;
  const disabled = windows || controlledByEnvironment;
  return (
    <SettingsRow
      title={TERMINAL_HOST_TITLE}
      description={note ? `${TERMINAL_HOST_DESCRIPTION} ${note}` : TERMINAL_HOST_DESCRIPTION}
      searchTerms={["terminal host", "background", "survive restart", "preview", "helper"]}
      control={
        <Switch
          tone="success"
          checked={windows ? false : controlledByEnvironment ? running : saved}
          disabled={disabled}
          onCheckedChange={(checked) => updateSettings({ terminalHostEnabled: Boolean(checked) })}
          aria-label={TERMINAL_HOST_TITLE}
        />
      }
    />
  );
}
