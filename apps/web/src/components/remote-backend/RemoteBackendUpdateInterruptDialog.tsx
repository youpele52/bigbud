import { useRef } from "react";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import type { InterruptFlow } from "./RemoteBackendUpdate.interrupt";

const KIND_LABELS = {
  turn: "Running turn",
  approval: "Pending approval",
  "user-input": "Waiting for an answer",
  shell: "Shell command",
  other: "Other work",
} as const;

/** Lists the exact affected work the consent digest covers. Confirming is the only way consent
 * is sent; a stale list is replaced and must be confirmed again. */
export function RemoteBackendUpdateInterruptDialog({ flow }: { readonly flow: InterruptFlow }) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const { review } = flow;
  const submitting = review.phase === "review" && review.submitting;
  return (
    <AlertDialog
      open={review.phase !== "closed"}
      onOpenChange={(open) => {
        if (!open && !submitting) flow.close();
      }}
    >
      <AlertDialogPopup
        className="max-w-lg p-0"
        bottomStickOnMobile={false}
        initialFocus={cancelButtonRef}
      >
        <ConfirmationPanel
          title="Interrupt work and update?"
          description="Remote backend update interruption confirmation"
          cancelLabel="Cancel"
          confirmLabel="Interrupt and update"
          confirmVariant="destructive"
          busy={submitting}
          cancelDisabled={submitting}
          cancelButtonRef={cancelButtonRef}
          confirmDisabled={review.phase !== "review"}
          onCancel={flow.close}
          onConfirm={() => void flow.confirm()}
          descriptionSlot={
            <div className="space-y-3" data-testid="remote-update-interrupt-review">
              {review.phase === "loading" ? (
                <p role="status" aria-live="polite">
                  Checking running work on this backend…
                </p>
              ) : review.phase === "unavailable" ? (
                <p role="alert" className="font-medium text-warning">
                  {review.message}
                </p>
              ) : review.phase === "review" ? (
                <>
                  {review.changed ? (
                    <p role="alert" className="font-medium text-warning">
                      The running work changed since you last looked. Review this list and confirm
                      again.
                    </p>
                  ) : null}
                  <p>Installing now stops this work on the remote backend:</p>
                  <ul aria-label="Affected work" className="list-disc space-y-1 pl-5">
                    {review.work.map((item) => (
                      <li key={`${item.kind}:${item.id}`} className="text-foreground">
                        <span className="text-muted-foreground">{KIND_LABELS[item.kind]}:</span>{" "}
                        {item.label}
                      </li>
                    ))}
                  </ul>
                  <p>Independent terminals keep running. Nothing else is stopped.</p>
                </>
              ) : null}
              {flow.error ? (
                <p role="alert" className="font-medium text-destructive">
                  {flow.error}
                </p>
              ) : null}
            </div>
          }
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}
