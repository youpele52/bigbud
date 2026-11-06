import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useOrganizationStatus } from "../../hooks/useOrganizationStatus";
import { organizationPausedCopy } from "../../lib/organizationStatusCopy";
import { persistServerSettings, useSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function InyosiraStatus() {
  const status = useOrganizationStatus();
  const dismissed = useSettings((settings) => settings.inyosiraIntroductionDismissed);
  const enabled = useSettings((settings) => settings.inyosiraPresentTargetEnabled);
  const [saving, setSaving] = useState(false);
  const paused = organizationPausedCopy(status);
  const decide = async (enable: boolean) => {
    setSaving(true);
    try {
      await persistServerSettings({
        inyosiraIntroductionDismissed: true,
        // Enabling keeps any target already configured in Settings (default 7).
        ...(enable ? { inyosiraPresentTargetEnabled: true } : {}),
      });
    } catch {
      toastManager.add({ type: "error", title: "Couldn't save Inyosira preference" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mx-2 space-y-2 text-xs text-muted-foreground">
      {paused ? <p role="status">{paused}</p> : null}
      {/* An explicit choice in Settings (on or off) is respected; only an unset choice asks. */}
      {status?.installation === "existing" && enabled == null && !dismissed ? (
        <div className="rounded-md bg-muted/50 p-2" aria-label="Inyosira introduction">
          <p>
            Keep Present focused with a soft target of 7 threads. Working threads always stay
            visible.
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button size="xs" variant="outline" disabled={saving} onClick={() => void decide(true)}>
              Enable
            </Button>
            <Link
              className="rounded px-2 py-1 text-xs underline underline-offset-2"
              to="/settings/general"
              hash="inyosira"
            >
              Settings
            </Link>
            <Button size="xs" variant="ghost" disabled={saving} onClick={() => void decide(false)}>
              Not now
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
