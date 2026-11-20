import { PROVIDER_DISPLAY_NAMES } from "@bigbud/contracts";
import { ArrowRightIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "../../lib/utils";
import { useSettings } from "../../hooks/useSettings";
import { useServerProviders } from "../../rpc/serverState";
import { buildProviderCards } from "../settings/ProvidersSettingsSection.logic";
import { Button } from "../ui/button";
import { countDiscoveredProviders, describeDiscoveredProviders } from "./WelcomeTourDialog.logic";

/** Same provider status Settings → Providers shows, as a compact read-only list. */
export function WelcomeTourProvidersStep({
  onOpenProvidersAfterTour,
}: {
  onOpenProvidersAfterTour: () => void;
}) {
  const settings = useSettings();
  const serverProviders = useServerProviders();
  const cards = useMemo(
    () => buildProviderCards({ serverProviders, settings }),
    [serverProviders, settings],
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {describeDiscoveredProviders(countDiscoveredProviders(serverProviders))}
      </p>
      <ul aria-label="AI providers" className="divide-y divide-border rounded-xl border">
        {cards.map((card) => (
          <li key={card.provider} className="flex items-center gap-2 px-3 py-2">
            <span
              aria-hidden="true"
              className={cn("size-2 shrink-0 rounded-full", card.statusStyle.dot)}
            />
            <span className="min-w-0 flex-1 truncate text-sm">
              {PROVIDER_DISPLAY_NAMES[card.provider] ?? card.title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{card.summary.headline}</span>
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        data-welcome-autofocus
        onClick={onOpenProvidersAfterTour}
      >
        Add more providers after the tour
        <ArrowRightIcon className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
