import { createFileRoute } from "@tanstack/react-router";

import { NotificationsSettingsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";

function SettingsNotificationsRouteView() {
  usePageTitle("Settings");

  return <NotificationsSettingsPanel />;
}

export const Route = createFileRoute("/settings/notifications")({
  component: SettingsNotificationsRouteView,
});
