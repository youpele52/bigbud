import type { GitBranch } from "@bigbud/contracts";
import { useEffect, useState } from "react";

import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
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
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

export function BranchToolbarBranchActionDialogs(props: {
  renameBranch: GitBranch | null;
  deleteBranch: GitBranch | null;
  onRenameOpenChange: (open: boolean) => void;
  onDeleteOpenChange: (open: boolean) => void;
  onRename: (branch: GitBranch, newName: string) => Promise<void>;
  onDelete: (branch: GitBranch) => Promise<void>;
}) {
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    if (props.renameBranch) setRenameValue(props.renameBranch.name);
  }, [props.renameBranch]);

  const trimmedRenameValue = renameValue.trim();
  const canRename = Boolean(
    props.renameBranch &&
    trimmedRenameValue.length > 0 &&
    trimmedRenameValue !== props.renameBranch.name &&
    !renameBusy,
  );

  const submitRename = async () => {
    if (!props.renameBranch || !canRename) return;
    setRenameBusy(true);
    try {
      await props.onRename(props.renameBranch, trimmedRenameValue);
      props.onRenameOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to rename branch.",
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setRenameBusy(false);
    }
  };

  const remove = async () => {
    if (!props.deleteBranch || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await props.onDelete(props.deleteBranch);
      props.onDeleteOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to delete branch.",
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={props.renameBranch !== null}
        onOpenChange={(open) => !renameBusy && props.onRenameOpenChange(open)}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename branch</DialogTitle>
            <DialogDescription>
              Enter a new name for “{props.renameBranch?.name}”.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="New branch name"
              autoFocus
              disabled={renameBusy}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void submitRename();
              }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={renameBusy}
              onClick={() => props.onRenameOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={!canRename} onClick={() => void submitRename()}>
              {renameBusy ? "Renaming..." : "Rename branch"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={props.deleteBranch !== null}
        onOpenChange={(open) => !deleteBusy && props.onDeleteOpenChange(open)}
      >
        <AlertDialogPopup className="max-w-sm p-0" bottomStickOnMobile={false}>
          <ConfirmationPanel
            title={`Delete branch "${props.deleteBranch?.name}"?`}
            description="Only the local branch will be deleted. This action cannot be undone."
            cancelLabel="Cancel"
            confirmLabel="Delete branch"
            confirmVariant="destructive"
            busy={deleteBusy}
            onCancel={() => props.onDeleteOpenChange(false)}
            onConfirm={() => void remove()}
          />
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
