import { INYOSIRA_DEFAULT_PRESENT_TARGET } from "@bigbud/contracts/core/settings.inyosira.ts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useOrganizationStatus } from "../../hooks/useOrganizationStatus";
import { persistServerSettings, useSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

export function InyosiraStatus() {
  const status = useOrganizationStatus();
  const dismissed = useSettings((settings) => settings.inyosiraIntroductionDismissed);
  const enabled = useSettings((settings) => settings.inyosiraPresentTargetEnabled);
  const target = useSettings((settings) => settings.inyosiraPresentTarget);
  const [saving, setSaving] = useState(false);
  const showIntroduction = status !== undefined && enabled !== false && !dismissed;
  const acknowledge = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await persistServerSettings({
        inyosiraIntroductionDismissed: true,
      });
    } catch {
      toastManager.add({ type: "error", title: "Couldn't save Inyosira preference" });
    } finally {
      setSaving(false);
    }
  };
  const close = () => {
    if (showIntroduction) void acknowledge();
  };
  return (
    <Dialog
      open={showIntroduction}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Room for every idea. Breathing room for your attention.</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <DialogDescription className="text-sm">
            Inyosira organises your threads around what needs you, what you’re working on, and what
            can wait. It aims for {target} threads in Present, moving inactive threads to Later as
            the list grows. Working threads always stay visible, and you can adjust the target
            anytime.
          </DialogDescription>
        </DialogPanel>
        <DialogFooter>
          <Link
            className="self-center rounded px-2 py-1 text-sm underline underline-offset-2"
            to="/settings/general"
            hash="inyosira"
            aria-disabled={saving}
            onClick={(event) => {
              if (saving) event.preventDefault();
              else if (showIntroduction) void acknowledge();
            }}
          >
            Change target
          </Link>
          <Button size="sm" disabled={saving} onClick={close}>
            {target === INYOSIRA_DEFAULT_PRESENT_TARGET ? "Use default" : "Keep current target"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
