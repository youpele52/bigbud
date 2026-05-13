import { createFileRoute } from "@tanstack/react-router";

import { KeybindingsSettingsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";

function SettingsKeybindingsRouteView() {
  usePageTitle("Settings");

  return <KeybindingsSettingsPanel />;
}

export const Route = createFileRoute("/settings/keybindings")({
  component: SettingsKeybindingsRouteView,
});
