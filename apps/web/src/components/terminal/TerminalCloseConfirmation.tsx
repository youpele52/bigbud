import { useEffect } from "react";

import { useTerminalCloseConfirmationStore } from "../../stores/terminal/terminalCloseConfirmation.store";
import { useTerminalLivenessStore } from "../../stores/terminal/terminalLiveness.store";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";

/** Asks before closing a busy terminal, or before "Close all". Mounted once at the root. */
export function TerminalCloseConfirmation() {
  const pending = useTerminalCloseConfirmationStore((state) => state.pending);
  const dismiss = useTerminalCloseConfirmationStore((state) => state.dismiss);
  // The shell exited while the dialog was open: nothing is left to confirm.
  const ended = useTerminalLivenessStore((state) =>
    pending?.watch
      ? state.byThreadId[pending.watch.threadId]?.[pending.watch.terminalId] === undefined
      : false,
  );
  useEffect(() => {
    if (ended) dismiss();
  }, [ended, dismiss]);

  const handleConfirm = () => {
    if (!pending) return;
    dismiss();
    pending.close();
  };

  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && dismiss()}>
      <AlertDialogPopup className="max-w-sm p-0" bottomStickOnMobile={false}>
        <ConfirmationPanel
          title={pending?.title ?? ""}
          description={pending?.description ?? ""}
          cancelLabel="Cancel"
          confirmLabel={pending?.confirmLabel ?? "Close"}
          confirmVariant="destructive"
          onCancel={dismiss}
          onConfirm={handleConfirm}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}
