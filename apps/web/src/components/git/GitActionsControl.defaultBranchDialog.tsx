import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import type { DefaultBranchActionDialogCopy } from "./GitActionsControl.logic";

interface DefaultBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  copy: DefaultBranchActionDialogCopy | null;
  onAbort: () => void;
  onContinueOnDefaultBranch: () => void;
  onCheckoutFeatureBranch: () => void;
}

export function DefaultBranchDialog({
  open,
  onOpenChange,
  copy,
  onAbort,
  onContinueOnDefaultBranch,
  onCheckoutFeatureBranch,
}: DefaultBranchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{copy?.title ?? "Run action on default branch?"}</DialogTitle>
          <DialogDescription>{copy?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onAbort}>
            Abort
          </Button>
          <Button variant="outline" size="sm" onClick={onContinueOnDefaultBranch}>
            {copy?.continueLabel ?? "Continue"}
          </Button>
          <Button size="sm" onClick={onCheckoutFeatureBranch}>
            Checkout feature branch & continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
