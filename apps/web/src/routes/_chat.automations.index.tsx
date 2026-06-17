import { createFileRoute } from "@tanstack/react-router";

import { AutomationsPage } from "~/components/automation/AutomationsPage";

export const Route = createFileRoute("/_chat/automations/")({
  component: AutomationsPage,
});
