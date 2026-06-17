import { Outlet, createFileRoute } from "@tanstack/react-router";

function AutomationsRouteLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/_chat/automations")({
  component: AutomationsRouteLayout,
});
