import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useOrganizationStatus } from "../../hooks/useOrganizationStatus";
import { organizationPausedCopy } from "../../lib/organizationStatusCopy";
import { persistServerSettings, useSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

export function InyosiraStatus() {
  const status = useOrganizationStatus();
  const dismissed = useSettings((settings) => settings.inyosiraIntroductionDismissed);
  const enabled = useSettings((settings) => settings.inyosiraPresentTargetEnabled);
  const [saving, setSaving] = useState(false);
  const [dismissedPaused, setDismissedPaused] = useState<string | null>(null);
  const paused = organizationPausedCopy(status);
  // An explicit choice in Settings (on or off) is respected; only an unset choice asks.
  const showIntroduction = status?.installation === "existing" && enabled == null && !dismissed;
  const decide = async (enable: boolean) => {
    setSaving(true);
    try {
      await persistServerSettings({
        inyosiraIntroductionDismissed: true,
        // Enabling keeps any target already configured in Settings (default 7).
        ...(enable ? { inyosiraPresentTargetEnabled: true } : {}),
      });
      setDismissedPaused(paused);
    } catch {
      toastManager.add({ type: "error", title: "Couldn't save Inyosira preference" });
    } finally {
      setSaving(false);
    }
  };
  const close = () => {
    if (saving) return;
    if (showIntroduction) void decide(false);
    else setDismissedPaused(paused);
  };
  return (
    <Dialog
      open={showIntroduction || (paused !== null && paused !== dismissedPaused)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Inyosira</DialogTitle>
          <DialogDescription className="space-y-3 text-sm">
            {paused ? (
              <span className="block" role="status">
                {paused}
              </span>
            ) : null}
            {showIntroduction ? (
              <span className="block">
                Keep Present focused with a soft target of 7 threads. Working threads always stay
                visible.
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Link
            className="self-center rounded px-2 py-1 text-sm underline underline-offset-2"
            to="/settings/general"
            hash="inyosira"
          >
            Settings
          </Link>
          <Button size="sm" variant="secondary" disabled={saving} onClick={close}>
            Not now
          </Button>
          {showIntroduction ? (
            <Button size="sm" disabled={saving} onClick={() => void decide(true)}>
              Enable
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
