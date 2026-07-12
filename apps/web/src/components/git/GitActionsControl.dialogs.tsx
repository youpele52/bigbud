import { type ComponentProps } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

import { CommitDialog } from "./GitActionsControl.commitDialog";
import { DefaultBranchDialog } from "./GitActionsControl.defaultBranchDialog";

export function GitActionsControlDialogs(props: {
  commitDialog: ComponentProps<typeof CommitDialog>;
  defaultBranchDialog: ComponentProps<typeof DefaultBranchDialog>;
  discard: { open: boolean; onOpenChange: (open: boolean) => void; onDiscard: () => void };
}) {
  return (
    <>
      <CommitDialog {...props.commitDialog} />
      <DefaultBranchDialog {...props.defaultBranchDialog} />
      <Dialog open={props.discard.open} onOpenChange={props.discard.onOpenChange}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Discard all changes?</DialogTitle>
            <DialogDescription>
              This will reset the working tree to the last commit. All uncommitted changes will be
              permanently lost. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={props.discard.onDiscard}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                Discard changes
              </Button>
              <Button variant="outline" size="sm" onClick={() => props.discard.onOpenChange(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
