import { createFileRoute } from "@tanstack/react-router";

import { SystemMonitorPage } from "~/components/resource-monitor/SystemMonitorPage";

export const Route = createFileRoute("/_chat/system-monitor/")({
  component: SystemMonitorPage,
});
