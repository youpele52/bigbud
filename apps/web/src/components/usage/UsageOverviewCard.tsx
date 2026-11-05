import { CpuIcon, FlameIcon, SigmaIcon } from "lucide-react";
import type { ComponentType } from "react";

import type { ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";

import { cn } from "~/lib/utils";
import { AiIcon } from "../AiIcon";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/provider/ProviderModelPicker.models";
import { Card } from "../ui/card";
import { usageSourceLabel } from "./UsageAccounting.logic";
import { UsageStatIcon } from "./UsagePage.stat";

type IconComponent = ComponentType<{ className?: string }>;

function UsageOverviewStat({
  icon,
  label,
  value,
  sourceLabel,
  emphasis = false,
}: {
  readonly icon: IconComponent;
  readonly label: string;
  readonly value: string;
  readonly sourceLabel?: string;
  readonly emphasis?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-4 px-6 py-4 @sm:px-8 @sm:even:border-l">
      <UsageStatIcon icon={icon} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-1 text-muted-foreground">
          <h3>{label}</h3>
          {sourceLabel ? <span className="text-sm">· {sourceLabel}</span> : null}
        </div>
        <div
          className={cn(
            "truncate text-foreground",
            emphasis ? "text-xl font-semibold" : "text-sm font-medium",
          )}
          title={value}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

/**
 * Totals and favourites in one 2×2 card, shared by the usage page and side panel. Sized by its
 * own width (container query) so a narrow panel stacks to one column whatever the window size.
 */
export function UsageOverviewCard({ summary }: { readonly summary: ServerUsageSummaryResult }) {
  return (
    <Card className="@container py-2">
      <div className="grid grid-cols-1 @sm:grid-cols-2" data-slot="usage-overview-grid">
        <UsageOverviewStat
          emphasis
          icon={SigmaIcon}
          label="Total tokens"
          sourceLabel={usageSourceLabel(summary.totals.accounting)}
          value={summary.totals.usedTokens.toLocaleString()}
        />
        <UsageOverviewStat
          icon={resolveUsageProviderIcon(summary.favoriteProvider?.id ?? null)}
          label="Top provider"
          value={summary.favoriteProvider?.label ?? "None"}
        />
        <UsageOverviewStat
          icon={AiIcon}
          label="Top model"
          value={summary.favoriteModel?.label ?? "None"}
        />
        <UsageOverviewStat
          icon={FlameIcon}
          label="Streak"
          value={`${summary.streakDays} ${summary.streakDays === 1 ? "day" : "days"}`}
        />
      </div>
    </Card>
  );
}

function resolveUsageProviderIcon(providerId: string | null): IconComponent {
  if (providerId && providerId in PROVIDER_ICON_BY_PROVIDER) {
    return PROVIDER_ICON_BY_PROVIDER[providerId as keyof typeof PROVIDER_ICON_BY_PROVIDER];
  }
  return CpuIcon;
}
