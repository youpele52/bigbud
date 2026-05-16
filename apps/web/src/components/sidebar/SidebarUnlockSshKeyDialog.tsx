import { type ReactNode } from "react";

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

interface SidebarUnlockSshKeyDialogProps {
  open: boolean;
  keyPath: string;
  description: ReactNode;
  title?: string;
  fieldLabel?: string;
  placeholder?: string;
  submitLabel?: string;
  secret: string;
  error: string | null;
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onSecretChange: (value: string) => void;
  onSubmit: () => void;
}

const passphraseInputClassName =
  "mt-1.5 flex border-border bg-card font-sans has-focus-visible:border-ring/45 has-focus-visible:ring-0";

export function SidebarUnlockSshKeyDialog({
  open,
  keyPath: _keyPath,
  description,
  title = "Unlock SSH key",
  fieldLabel = "Key passphrase",
  placeholder = "Enter the SSH key passphrase",
  submitLabel = "Unlock SSH key",
  secret,
  error,
  isSubmitting,
  onOpenChange,
  onSecretChange,
  onSubmit,
}: SidebarUnlockSshKeyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <label htmlFor="remote-project-key-passphrase" className="block">
            <span className="text-xs font-medium text-foreground">{fieldLabel}</span>
            <Input
              id="remote-project-key-passphrase"
              autoFocus
              type="password"
              className={passphraseInputClassName}
              placeholder={placeholder}
              spellCheck={false}
              value={secret}
              onChange={(event) => onSecretChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isSubmitting) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
          </label>

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive text-xs leading-4">
              {error}
            </div>
          ) : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={isSubmitting || secret.trim().length === 0}
            onClick={onSubmit}
          >
            {isSubmitting ? "Submitting..." : submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
