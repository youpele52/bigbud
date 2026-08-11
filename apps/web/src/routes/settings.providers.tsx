import { createFileRoute } from "@tanstack/react-router";

import { ProvidersSettingsPanel } from "../components/settings/SettingsPanels";
import { usePageTitle } from "../hooks/usePageTitle";
import { parseExpandedProvidersSearch } from "./-settings.providers.search";

function SettingsProvidersRouteView() {
  usePageTitle("Settings");
  const { providers } = Route.useSearch();

  return <ProvidersSettingsPanel expandedProviders={providers} />;
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (search) => ({
    providers: parseExpandedProvidersSearch(search),
  }),
  component: SettingsProvidersRouteView,
});
