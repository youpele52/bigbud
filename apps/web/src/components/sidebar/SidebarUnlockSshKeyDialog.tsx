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
import { getSshHostTrustChallenge } from "../../lib/ssh";

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
  keyPath,
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
  const hostTrust = getSshHostTrustChallenge(keyPath);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{hostTrust ? "Trust SSH server?" : title}</DialogTitle>
          <DialogDescription>
            {hostTrust
              ? "This server is not yet trusted. Verify its fingerprint with your VPS provider or administrator before connecting."
              : description}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          {hostTrust ? (
            <div className="space-y-3 text-sm">
              <dl className="space-y-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Server</dt>
                  <dd className="break-all">{hostTrust.host}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{hostTrust.keyType} fingerprint</dt>
                  <dd className="break-all font-mono">{hostTrust.fingerprint}</dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                Trust will be saved in your SSH known_hosts file, shared with Terminal and VS Code.
              </p>
              {error ? (
                <p role="alert" className="text-destructive text-xs">
                  {error}
                </p>
              ) : null}
            </div>
          ) : (
            <label htmlFor="remote-project-key-passphrase" className="block">
              <span className="text-xs font-medium text-foreground">{fieldLabel}</span>
              <Input
                id="remote-project-key-passphrase"
                autoFocus
                type="password"
                className={passphraseInputClassName}
                aria-invalid={error ? true : undefined}
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
              {error ? <p className="mt-1.5 text-destructive text-xs leading-4">{error}</p> : null}
            </label>
          )}
        </DialogPanel>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={isSubmitting || (!hostTrust && secret.trim().length === 0)}
            onClick={onSubmit}
          >
            {isSubmitting ? "Connecting..." : hostTrust ? "Trust and connect" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
