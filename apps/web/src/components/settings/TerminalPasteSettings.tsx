import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const SIZE_OPTIONS = [10, 20, 50, 100, 200] as const;

/** Pasted and dropped files: the per-file cap and OSC 5522 clipboard requests. */
export function TerminalPasteSettings() {
  const maxFileMb = useSettings((settings) => settings.terminalPasteMaxFileMb);
  const clipboardRequests = useSettings((settings) => settings.terminalClipboardRequests);
  const { updateSettings } = useUpdateSettings();
  return (
    <>
      <SettingsRow
        title="Largest pasted file"
        description="Pasted images and files land as a full path on the machine running the terminal; on remote terminals they upload there automatically. Larger files are refused. Staged files are deleted when the terminal closes."
        searchTerms={["paste", "image", "screenshot", "upload", "size"]}
        resetAction={
          maxFileMb !== DEFAULT_UNIFIED_SETTINGS.terminalPasteMaxFileMb ? (
            <SettingResetButton
              label="largest pasted file"
              onClick={() =>
                updateSettings({
                  terminalPasteMaxFileMb: DEFAULT_UNIFIED_SETTINGS.terminalPasteMaxFileMb,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={String(maxFileMb)}
            onValueChange={(value) => {
              const next = Number(value);
              if ((SIZE_OPTIONS as ReadonlyArray<number>).includes(next))
                updateSettings({ terminalPasteMaxFileMb: next });
            }}
          >
            <SelectTrigger
              aria-label="Largest pasted file"
              variant="muted-outline"
              className="w-full sm:w-32"
            >
              <SelectValue>{`${maxFileMb} MB`}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {SIZE_OPTIONS.map((size) => (
                <SelectItem hideIndicator key={size} value={String(size)}>
                  {size} MB
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Clipboard requests from terminal programs"
        description="Answer kitty clipboard protocol (OSC 5522) reads, including images, only for the pane you just pasted into and only for a few seconds. Programs can never write your clipboard this way."
        searchTerms={["osc 5522", "kitty", "ghostty", "clipboard"]}
        control={
          <Switch
            tone="success"
            checked={clipboardRequests}
            onCheckedChange={(checked) =>
              updateSettings({ terminalClipboardRequests: Boolean(checked) })
            }
            aria-label="Clipboard requests from terminal programs"
          />
        }
      />
    </>
  );
}
