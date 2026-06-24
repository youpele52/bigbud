import { createFileRoute } from "@tanstack/react-router";

import { RemoteSettingsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";

function SettingsRemoteRouteView() {
  usePageTitle("Remote");

  return <RemoteSettingsPanel />;
}

export const Route = createFileRoute("/settings/remote")({
  component: SettingsRemoteRouteView,
});
