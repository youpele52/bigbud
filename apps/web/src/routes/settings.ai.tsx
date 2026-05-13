import { createFileRoute } from "@tanstack/react-router";

import { AiSettingsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";

function SettingsAiRouteView() {
  usePageTitle("Settings");

  return <AiSettingsPanel />;
}

export const Route = createFileRoute("/settings/ai")({
  component: SettingsAiRouteView,
});
