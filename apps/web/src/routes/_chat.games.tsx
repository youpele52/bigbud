import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";

function GamesRouteLayout() {
  useEffect(() => useRightPanelTabsStore.getState().closeRightPanel(), []);
  return <Outlet />;
}

export const Route = createFileRoute("/_chat/games")({ component: GamesRouteLayout });
