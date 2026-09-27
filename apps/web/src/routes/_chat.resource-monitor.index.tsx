import { createFileRoute } from "@tanstack/react-router";

import { ResourceMonitorPage } from "~/components/resource-monitor/ResourceMonitorPage";

export const Route = createFileRoute("/_chat/resource-monitor/")({
  component: ResourceMonitorPage,
});
