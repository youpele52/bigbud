import { useEffect } from "react";

import { useTerminalCloseConfirmationStore } from "../../stores/terminal/terminalCloseConfirmation.store";
import { useTerminalLivenessStore } from "../../stores/terminal/terminalLiveness.store";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";

/** Asks before closing a terminal that still has a program running. Mounted once at the root. */
export function TerminalCloseConfirmation() {
  const pending = useTerminalCloseConfirmationStore((state) => state.pending);
  const dismiss = useTerminalCloseConfirmationStore((state) => state.dismiss);
  // The shell exited while the dialog was open: nothing is left to confirm.
  const ended = useTerminalLivenessStore((state) =>
    pending ? state.byThreadId[pending.threadId]?.[pending.terminalId] === undefined : false,
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
          title="Close running terminal?"
          description={`A process is still running in “${pending?.label ?? "Terminal"}”. Closing stops it and deletes its history.`}
          cancelLabel="Cancel"
          confirmLabel="Close terminal"
          confirmVariant="destructive"
          onCancel={dismiss}
          onConfirm={handleConfirm}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}
