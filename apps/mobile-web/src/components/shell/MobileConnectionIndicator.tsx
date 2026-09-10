import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";
import { cn } from "../../lib/cn";
import { describeMobileConnection } from "./MobileNavigationSheet.logic";

export function MobileConnectionIndicator({ state }: { readonly state: MobileRecoveryState }) {
  const label = describeMobileConnection(state);
  const tone =
    state.freshness === "current"
      ? "bg-success"
      : state.freshness === "refreshing"
        ? "bg-info"
        : state.freshness === "stale" || state.freshness === "legacy"
          ? "bg-warning"
          : "bg-destructive";

  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone)} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
