import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { deleteConfirmationCopy, type DeleteEntryTarget } from "./FilesPanel.entryActions.logic";

interface FilesPanelDeleteDialogProps {
  readonly target: DeleteEntryTarget | null;
  readonly permanent: boolean;
  readonly remote: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/** Every delete asks first; the copy says whether it goes to the Trash or is permanent. */
export function FilesPanelDeleteDialog({
  target,
  permanent,
  remote,
  busy,
  onCancel,
  onConfirm,
}: FilesPanelDeleteDialogProps) {
  const copy = target ? deleteConfirmationCopy({ target, permanent, remote }) : null;
  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <AlertDialogPopup className="max-w-md p-0" bottomStickOnMobile={false}>
        {copy ? (
          <ConfirmationPanel
            title={copy.title}
            description={copy.description}
            cancelLabel="Cancel"
            confirmLabel={copy.confirmLabel}
            confirmVariant="destructive"
            busy={busy}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
