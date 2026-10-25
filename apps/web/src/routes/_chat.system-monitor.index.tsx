import { createFileRoute } from "@tanstack/react-router";

import { SystemMonitorPage } from "~/components/resource-monitor/SystemMonitorPage";
import type { MonitorScope } from "~/components/resource-monitor/MonitorScopeToggle";

function SystemMonitorRoute() {
  const { monitorScope } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SystemMonitorPage
      scope={monitorScope ?? "system"}
      onScopeChange={(scope) => {
        void navigate({ search: { monitorScope: scope }, replace: true });
      }}
    />
  );
}

export const Route = createFileRoute("/_chat/system-monitor/")({
  validateSearch: (search: Record<string, unknown>): { monitorScope?: MonitorScope } => ({
    monitorScope: search.monitorScope === "bigbud" ? "bigbud" : "system",
  }),
  component: SystemMonitorRoute,
});
