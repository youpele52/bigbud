import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";

interface ConfirmationPanelProps {
  title: ReactNode;
  description: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirmVariant?: "default" | "destructive";
  busy?: boolean;
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
  className,
  titleSlot,
  descriptionSlot,
}: ConfirmationPanelProps) {
  return (
    <div className={cn("flex flex-col gap-3 p-4 sm:p-5", className)}>
      <div className="space-y-1.5">
        {titleSlot ?? <div className="text-sm font-medium text-foreground/90">{title}</div>}
        {descriptionSlot ?? (
          <p className="text-[13px] leading-5 font-normal text-muted-foreground">{description}</p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button size="sm" variant={confirmVariant} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
