import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";

function SettingsArchivedRouteView() {
  usePageTitle("Archived threads");

  return <ArchivedThreadsPanel />;
}

export const Route = createFileRoute("/settings/archived")({
  component: SettingsArchivedRouteView,
});
