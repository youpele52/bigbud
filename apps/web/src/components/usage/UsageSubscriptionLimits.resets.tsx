import type { ServerProviderManualResets } from "@bigbud/contracts/server/usageLimits.ts";
import { Separator } from "../ui/separator";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { limitResetExpiryRows } from "./UsageSubscriptionLimits.resets.logic";
import { formatSubscriptionTimestamp } from "./UsageSubscriptionLimits.timestamp";

export function UsageSubscriptionManualResets({
  resets,
}: {
  readonly resets: ServerProviderManualResets;
}) {
  const missing = resets.availableCount - resets.availableExpiries.length;
  return (
    <section aria-label="Limit resets" className="space-y-2">
      <Separator className="data-[orientation=horizontal]:w-1/2" />
      <h4 className="text-xs font-normal">Limit resets</h4>
      {/* No redemption timestamps are exposed, so there is no History view to switch to. */}
      <ToggleGroup
        aria-label="Limit reset view"
        size="xs"
        variant="toolbar"
        value={["available"]}
        disabled
      >
        <Toggle value="available" className="text-xs font-normal disabled:opacity-100 sm:text-xs">
          Available ({resets.availableCount.toLocaleString()})
        </Toggle>
      </ToggleGroup>
      <div className="space-y-1 text-xs text-muted-foreground">
        {resets.availableCount === 0 ? <p>No available resets</p> : null}
        {resets.availableExpiries.length > 0 ? (
          <ul aria-label="Available reset expiries" className="space-y-1">
            {limitResetExpiryRows(resets.availableExpiries).map(({ key, expiry }) => (
              <li key={key}>
                {expiry === null ? (
                  "No expiry"
                ) : (
                  <time dateTime={expiry}>Expires {formatSubscriptionTimestamp(expiry)}</time>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {resets.availableCount > 0 && !resets.detailsComplete ? (
          <p>
            {missing > 0
              ? `Expiry unavailable for ${missing} reset${missing === 1 ? "" : "s"}`
              : "Expiry details may be incomplete"}
          </p>
        ) : null}
      </div>
    </section>
  );
}
