import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

/** Opt-in bounded metadata only; never payloads, screenshots or typed text. */
export function ComputerUseDiagnosticsRow({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow
      title="Diagnostic metadata"
      description="Record versions, health, durations and failure codes. Screenshots, typed text and app contents are never recorded."
      control={
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onChange(Boolean(next))}
          aria-label="Record computer use diagnostic metadata"
        />
      }
    />
  );
}
