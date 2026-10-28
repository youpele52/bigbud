import type { ComputerUseDeliveryMode } from "@bigbud/contracts/core/settings.computerUsePolicy";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

const LABELS: Record<ComputerUseDeliveryMode, string> = {
  foreground: "Foreground",
  background: "Background",
};

/** Default delivery for actions that omit it; a refusal is never escalated. */
export function ComputerUseDeliveryPreferenceRow({
  value,
  disabled,
  onChange,
}: {
  value: ComputerUseDeliveryMode;
  disabled: boolean;
  onChange: (value: ComputerUseDeliveryMode) => void;
}) {
  return (
    <SettingsRow
      title="Interaction preference"
      description="How agents interact with apps when an action does not ask for a specific mode."
      control={
        <Select
          value={value}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === "foreground" || next === "background") onChange(next);
          }}
        >
          <SelectTrigger
            aria-label="Computer use interaction preference"
            variant="muted-outline"
            className="w-full sm:w-40"
          >
            <SelectValue>{LABELS[value]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(["foreground", "background"] as const).map((mode) => (
              <SelectItem hideIndicator key={mode} value={mode}>
                {LABELS[mode]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
