import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { enableComputerUseInBackground } from "./computerUseEnable";
import {
  getComputerUseDialogDescription,
  getComputerUsePermissionPromptDescription,
} from "./computerUsePlatformCopy";

interface ComputerUsePermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ComputerUsePermissionDialog({
  open,
  onOpenChange,
}: ComputerUsePermissionDialogProps) {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const { updateSettings } = useUpdateSettings();
  const queryClient = useQueryClient();

  const handleEnable = useCallback(async () => {
    enableComputerUseInBackground({
      queryClient,
      updateSettings,
      closePrompt: () => onOpenChange(false),
    });
  }, [onOpenChange, queryClient, updateSettings]);

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
          <DialogDescription>{getComputerUseDialogDescription()}</DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4 text-xs text-muted-foreground">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Allow computer use</p>
            <p>{getComputerUsePermissionPromptDescription(platform)}</p>
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
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleDismiss}>
            Maybe Later
          </Button>
          <Button size="sm" onClick={() => void handleEnable()}>
            <span className="flex items-center gap-1.5">
              <CheckIcon className="size-3.5" />
              Enable
            </span>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
