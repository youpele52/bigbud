import type { ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { AlertDialogDescription, AlertDialogTitle } from "../ui/alert-dialog";

interface ConfirmationPanelProps {
  title: ReactNode;
  description: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirmVariant?: "default" | "destructive";
  busy?: boolean;
  confirmDisabled?: boolean;
  cancelButtonRef?: Ref<HTMLButtonElement>;
  className?: string;
  titleSlot?: ReactNode;
  descriptionSlot?: ReactNode;
}

export function ConfirmationPanel({
  title,
  description,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  confirmVariant = "default",
  busy = false,
  confirmDisabled = false,
  cancelButtonRef,
  className,
  titleSlot,
  descriptionSlot,
}: ConfirmationPanelProps) {
  return (
    <div className={cn("flex max-h-full min-h-0 flex-col gap-3 p-4 sm:p-5", className)}>
      <div className="min-h-0 space-y-1.5 overflow-y-auto overscroll-contain">
        <AlertDialogTitle className="text-sm font-medium text-foreground/90">
          {titleSlot ?? title}
        </AlertDialogTitle>
        <AlertDialogDescription
          render={<div />}
          className="text-xs leading-5 font-normal text-muted-foreground"
        >
          {descriptionSlot ?? description}
        </AlertDialogDescription>
      </div>

      <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        <Button
          size="sm"
          variant={confirmVariant === "destructive" ? "ghost" : confirmVariant}
          disabled={busy || confirmDisabled}
          onClick={onConfirm}
          className={
            confirmVariant === "destructive"
              ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
              : undefined
          }
        >
          {confirmLabel}
        </Button>
        <Button
          ref={cancelButtonRef}
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}
