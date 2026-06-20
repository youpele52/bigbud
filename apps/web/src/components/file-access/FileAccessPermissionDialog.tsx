import { useCallback, useState } from "react";
import { ShieldIcon, FolderOpenIcon, CheckIcon } from "lucide-react";
import {
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { useUpdateSettings } from "../../hooks/useSettings";

interface FileAccessPermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FileAccessPermissionDialog({
  open,
  onOpenChange,
}: FileAccessPermissionDialogProps) {
  const { updateSettings } = useUpdateSettings();
  const [selectedLevel, setSelectedLevel] = useState<"unrestricted" | "common-folders">(
    "unrestricted",
  );
  const [isRequesting, setIsRequesting] = useState(false);

  const handleAllow = useCallback(async () => {
    setIsRequesting(true);

    updateSettings({
      fileAccessPermissionLevel: selectedLevel,
      hasSeenFileAccessPrompt: true,
    });

    setIsRequesting(false);
    onOpenChange(false);
  }, [selectedLevel, updateSettings, onOpenChange]);

  const handleDismiss = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          handleDismiss();
        }
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport>
          <DialogPopup className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldIcon className="size-4 text-primary" />
                Allow bigbud to access your files
              </DialogTitle>
              <DialogDescription>
                bigbud needs access to your folders to help you work with projects, documents, and
                files.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              <button
                type="button"
                onClick={() => setSelectedLevel("unrestricted")}
                className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors ${
                  selectedLevel === "unrestricted"
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:bg-accent"
                }`}
              >
                <div
                  className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${
                    selectedLevel === "unrestricted" ? "border-primary" : "border-muted-foreground"
                  }`}
                >
                  {selectedLevel === "unrestricted" && (
                    <div className="size-2.5 rounded-full bg-primary" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">All files and folders</span>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      Recommended
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    bigbud can access any file on your system for the best experience and full
                    functionality.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSelectedLevel("common-folders")}
                className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors ${
                  selectedLevel === "common-folders"
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:bg-accent"
                }`}
              >
                <div
                  className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${
                    selectedLevel === "common-folders"
                      ? "border-primary"
                      : "border-muted-foreground"
                  }`}
                >
                  {selectedLevel === "common-folders" && (
                    <div className="size-2.5 rounded-full bg-primary" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">Commonly used folders only</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Desktop, Documents, Downloads, Music, and Pictures.
                  </p>
                </div>
              </button>

              <div className="flex items-start gap-2 px-7 py-1 mt-8">
                <FolderOpenIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <p className="text-[11px] text-muted-foreground">
                  You can change this anytime in Settings → General → File Access. macOS will ask
                  you to confirm access for each folder.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={handleDismiss} disabled={isRequesting}>
                Maybe Later
              </Button>
              <Button size="sm" onClick={() => void handleAllow()} disabled={isRequesting}>
                {isRequesting ? (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Saving...
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <CheckIcon className="size-3.5" />
                    Allow
                  </span>
                )}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
