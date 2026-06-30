import { useCallback, useState } from "react";
import { BotIcon, CheckIcon, ShieldAlertIcon } from "lucide-react";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { useUpdateSettings } from "../../hooks/useSettings";

interface ComputerUsePermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ComputerUsePermissionDialog({
  open,
  onOpenChange,
}: ComputerUsePermissionDialogProps) {
  const { updateSettings } = useUpdateSettings();
  const [isRequesting, setIsRequesting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleEnable = useCallback(async () => {
    setIsRequesting(true);
    setErrorMessage(null);

    try {
      const bridge = window.desktopBridge;
      if (bridge?.installComputerUseRuntime) {
        const installResult = await bridge.installComputerUseRuntime();
        if (!installResult.ok) {
          throw new Error(installResult.status.message ?? "Computer Use runtime install failed.");
        }
      }
      if (bridge?.requestComputerUsePermissions) {
        const permissions = await bridge.requestComputerUsePermissions();
        if (!permissions.granted) {
          throw new Error(
            permissions.message ??
              "Computer Use needs Accessibility and Screen Recording permissions before it can be enabled.",
          );
        }
      }
      updateSettings({
        computerUseEnabled: true,
        hasSeenComputerUsePrompt: true,
      });
      onOpenChange(false);
    } catch (error) {
      updateSettings({
        computerUseEnabled: false,
        hasSeenComputerUsePrompt: true,
      });
      setErrorMessage(
        error instanceof Error ? error.message : "Computer Use could not be enabled.",
      );
    } finally {
      setIsRequesting(false);
    }
  }, [onOpenChange, updateSettings]);

  const handleDismiss = useCallback(() => {
    updateSettings({
      computerUseEnabled: false,
      hasSeenComputerUsePrompt: true,
    });
    onOpenChange(false);
  }, [onOpenChange, updateSettings]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          handleDismiss();
        }
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BotIcon className="size-4 text-primary" />
            Enable Computer Use
          </DialogTitle>
          <DialogDescription>
            bigbud can automate native macOS apps and the in-app browser so agents can help with
            tasks like checking Calendar, reading Reminders, and interacting with other desktop
            software.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4 text-xs text-muted-foreground">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Allow computer use</p>
            <p>
              Requires Accessibility and Screen Recording. macOS will prompt you after you continue.
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Disable computer use</p>
            <p>Only browser automation inside bigbud will work.</p>
          </div>

          <div className="flex items-start gap-2 px-1 pt-1">
            <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <p className="text-[11px] text-muted-foreground">
              You can change this anytime in Settings → AI → Computer Use.
            </p>
          </div>

          {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleDismiss} disabled={isRequesting}>
            Maybe Later
          </Button>
          <Button size="sm" onClick={() => void handleEnable()} disabled={isRequesting}>
            {isRequesting ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Requesting...
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <CheckIcon className="size-3.5" />
                Enable
              </span>
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
