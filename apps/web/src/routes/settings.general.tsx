import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";

function SettingsGeneralRouteView() {
  usePageTitle("Settings");

  return <GeneralSettingsPanel />;
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRouteView,
});
