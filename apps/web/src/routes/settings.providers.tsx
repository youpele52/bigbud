import { createFileRoute } from "@tanstack/react-router";

import { ProvidersSettingsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";

function SettingsProvidersRouteView() {
  usePageTitle("Settings");

  return <ProvidersSettingsPanel />;
}

export const Route = createFileRoute("/settings/providers")({
  component: SettingsProvidersRouteView,
});
