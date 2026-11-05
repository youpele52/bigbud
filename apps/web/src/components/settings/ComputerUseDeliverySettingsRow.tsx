import { selectedComputerUseContractProfile } from "@bigbud/shared/computer-use/selection";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ComputerUseDeliveryPreferenceRow } from "./ComputerUseDeliveryPreferenceRow";

/** The active desktop path reads this server-authoritative preference for every action. */
export function ComputerUseDeliverySettingsRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  if (selectedComputerUseContractProfile !== "legacy") return null;
  return (
    <ComputerUseDeliveryPreferenceRow
      value={settings.computerUseDeliveryMode}
      disabled={!settings.computerUseEnabled}
      onChange={(computerUseDeliveryMode) => updateSettings({ computerUseDeliveryMode })}
      description="Background keeps the agent on its selected app without switching your focus. Unsupported actions stop. Choose Foreground to allow focus changes."
    />
  );
}
