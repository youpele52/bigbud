import { useCallback, useState } from "react";

import { ConfirmationPanel } from "../../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../../ui/alert-dialog";

const backgroundSubagentsLabel = (count: number) =>
  count === 1 ? "1 background subagent" : `${count} background subagents`;

/**
 * Thread Stop stops every subagent, including background ones that would otherwise outlive the
 * turn. When any are running, Stop asks first; otherwise it stops immediately. Provider-agnostic.
 */
export function useConfirmedThreadStop(input: {
  readonly backgroundSubagentCount: number;
  readonly onInterrupt: () => void;
}) {
  const { backgroundSubagentCount, onInterrupt } = input;
  const [open, setOpen] = useState(false);
  const requestStop = useCallback(() => {
    if (backgroundSubagentCount > 0) setOpen(true);
    else onInterrupt();
  }, [backgroundSubagentCount, onInterrupt]);

  const confirmation = (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogPopup className="max-w-sm p-0" bottomStickOnMobile={false}>
        <ConfirmationPanel
          title="Stop this thread?"
          description={`This also stops its ${backgroundSubagentsLabel(backgroundSubagentCount)}. Their unfinished work won't be completed.`}
          cancelLabel="Keep running"
          confirmLabel="Stop all"
          confirmVariant="destructive"
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            setOpen(false);
            onInterrupt();
          }}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );

  return { requestStop, confirmation };
}
