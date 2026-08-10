import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";

function PluginsRouteLayout() {
  useEffect(() => useRightPanelTabsStore.getState().closeRightPanel(), []);
  return <Outlet />;
}

export const Route = createFileRoute("/_chat/plugins")({ component: PluginsRouteLayout });
