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
  passphrase: string;
  error: string | null;
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onPassphraseChange: (value: string) => void;
  onSubmit: () => void;
}

const passphraseInputClassName =
  "mt-1.5 flex border-border bg-card font-sans has-focus-visible:border-ring/45 has-focus-visible:ring-0";

export function SidebarUnlockSshKeyDialog({
  open,
  keyPath: _keyPath,
  description,
  passphrase,
  error,
  isSubmitting,
  onOpenChange,
  onPassphraseChange,
  onSubmit,
}: SidebarUnlockSshKeyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Unlock SSH key</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <label htmlFor="remote-project-key-passphrase" className="block">
            <span className="text-xs font-medium text-foreground">Key passphrase</span>
            <Input
              id="remote-project-key-passphrase"
              autoFocus
              type="password"
              className={passphraseInputClassName}
              placeholder="Enter the SSH key passphrase"
              spellCheck={false}
              value={passphrase}
              onChange={(event) => onPassphraseChange(event.target.value)}
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
            disabled={isSubmitting || passphrase.trim().length === 0}
            onClick={onSubmit}
          >
            {isSubmitting ? "Unlocking..." : "Unlock SSH key"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
