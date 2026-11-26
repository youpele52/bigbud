import { useRef } from "react";

import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import type { SshLegacyDrainFlow } from "./SshLegacyDrainDialog.types";

/**
 * U5/U8 consent for a supported upgrade. Cancel aborts the upgrade and leaves the
 * backend running with its lock; it never drains, clears or retires anything.
 * There is no restart action here: a drained pane stays closed.
 */
export function SshLegacyDrainDialog({ flow }: { readonly flow: SshLegacyDrainFlow }) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const busy = flow.phase === "submitting";
  const refusal = flow.reason === "startup-refusal";
  return (
    <AlertDialog
      open={flow.phase !== "closed"}
      onOpenChange={(open) => {
        if (!open && !busy) flow.cancel();
      }}
    >
      <AlertDialogPopup className="max-w-lg" bottomStickOnMobile={false}>
        <div className="space-y-1.5">
          <AlertDialogTitle className="text-sm font-medium text-foreground/90">
            {refusal
              ? "SSH is unavailable until the previous terminals drain"
              : "SSH terminals must close for this upgrade"}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-xs leading-5 text-muted-foreground">
            {refusal
              ? "The previous version did not record a completed drain. Local work continues; these SSH terminals close and do not reopen."
              : "These terminals connect through this backend. They close for the upgrade and do not reopen."}
          </AlertDialogDescription>
        </div>
        <ul
          aria-label="Affected panes"
          className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2"
        >
          {flow.panes.map((pane) => (
            <li
              key={pane.paneId}
              data-testid={`ssh-drain-pane-${pane.paneId}`}
              className="rounded px-2 py-1 text-xs"
            >
              <span className="font-medium text-foreground">{pane.threadTitle}</span>
              <span className="text-muted-foreground"> / {pane.paneTitle}</span>
              <span className="block text-muted-foreground">{pane.route}</span>
            </li>
          ))}
        </ul>
        {flow.phase === "error" ? (
          <div className="space-y-2" role="alert">
            <p className="text-xs font-medium text-destructive">
              {flow.error ?? "The panes could not be listed. Nothing was drained."}
            </p>
            <Button size="sm" variant="outline" onClick={flow.retry}>
              Retry
            </Button>
          </div>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <Button
            ref={cancelButtonRef}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={flow.cancel}
          >
            Cancel
          </Button>
          {refusal ? null : (
            <Button size="sm" variant="secondary" disabled={busy} onClick={flow.saveAndClose}>
              Save and close
            </Button>
          )}
          <Button size="sm" variant="destructive" disabled={busy} onClick={flow.drainNow}>
            {refusal ? "Drain identified panes" : "Drain now"}
          </Button>
        </div>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
