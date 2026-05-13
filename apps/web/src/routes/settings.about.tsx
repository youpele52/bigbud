import { createFileRoute } from "@tanstack/react-router";

import { AboutSettingsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";

function SettingsAboutRouteView() {
  usePageTitle("Settings");

  return <AboutSettingsPanel />;
}

export const Route = createFileRoute("/settings/about")({
  component: SettingsAboutRouteView,
});
