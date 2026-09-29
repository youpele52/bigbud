import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/resource-monitor")({
  beforeLoad: () => {
    throw redirect({ to: "/system-monitor", replace: true });
  },
});
