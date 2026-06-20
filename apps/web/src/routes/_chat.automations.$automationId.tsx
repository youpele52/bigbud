import { AutomationId } from "@bigbud/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AutomationDetailPage } from "~/components/automation/AutomationDetailPage";

export const Route = createFileRoute("/_chat/automations/$automationId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { automationId } = Route.useParams();

  return <AutomationDetailPage automationId={AutomationId.makeUnsafe(automationId)} />;
}
