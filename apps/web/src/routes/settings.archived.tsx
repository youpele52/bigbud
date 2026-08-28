import { ThreadId } from "@bigbud/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";

function SettingsArchivedRouteView() {
  usePageTitle("Archived threads");
  const { threadId } = Route.useSearch();

  return <ArchivedThreadsPanel targetThreadId={threadId} />;
}

export const Route = createFileRoute("/settings/archived")({
  validateSearch: (search): { threadId?: ThreadId } =>
    typeof search.threadId === "string" && search.threadId.length > 0
      ? { threadId: ThreadId.makeUnsafe(search.threadId) }
      : {},
  component: SettingsArchivedRouteView,
});
