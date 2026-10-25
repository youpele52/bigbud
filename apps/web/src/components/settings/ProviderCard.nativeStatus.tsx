import type { OpenCodeSettingsStatus } from "./ProvidersSettingsSection.opencode";
import { ProviderDetails } from "./ProviderDetails";

/** Keep account identity and setup diagnostics out of the collapsed authentication headline. */
export function ProviderNativeStatus({ status }: { status: OpenCodeSettingsStatus }) {
  return (
    <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs sm:px-5">
      {status.accounts ? (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Accounts:</span> {status.accounts}
        </p>
      ) : null}
      {status.attention ? (
        <p className={status.attention.tone === "error" ? "text-destructive" : "text-warning"}>
          {status.attention.message}
        </p>
      ) : null}
      {status.historyAdvisory ? (
        <ProviderDetails label="Native history">
          <p>{status.historyAdvisory}</p>
        </ProviderDetails>
      ) : null}
    </div>
  );
}
