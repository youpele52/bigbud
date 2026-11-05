import {
  selectedComputerUseContractProfile,
  type ComputerUseContractProfile,
} from "@bigbud/shared/computer-use/selection";

import type { SupervisedSettingsPort } from "./ComputerUseSupervisedSettings.logic";
import { ComputerUseSupervisedSettingsAreas } from "./ComputerUseSupervisedSettingsAreas";

/**
 * Supervised computer-use settings (plan M5). Renders nothing while the
 * legacy profile is selected (any Driver pin), so new safety controls are never shown as
 * enforced by legacy mode. Under v2 without a connected port every control is
 * inert and the rows say so.
 */
export function ComputerUseSupervisedSettings({
  profile = selectedComputerUseContractProfile,
  port = null,
}: {
  profile?: ComputerUseContractProfile;
  port?: SupervisedSettingsPort | null;
}) {
  if (profile !== "v2") return null;
  return <ComputerUseSupervisedSettingsAreas port={port} />;
}
