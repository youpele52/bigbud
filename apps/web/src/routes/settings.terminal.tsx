import { createFileRoute } from "@tanstack/react-router";

import { TerminalSettingsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";

function SettingsTerminalRouteView() {
  usePageTitle("Settings");

  return <TerminalSettingsPanel />;
}

export const Route = createFileRoute("/settings/terminal")({
  component: SettingsTerminalRouteView,
});
