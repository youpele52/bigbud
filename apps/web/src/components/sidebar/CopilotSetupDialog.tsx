import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useCopilotRuntime } from "../../hooks/useCopilotRuntime";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";

export function CopilotSetupDialog({
  open,
  onClose,
  onFailure,
}: {
  open: boolean;
  onClose: () => void;
  onFailure: (message: string) => void;
}) {
  const navigate = useNavigate();
  const { act, dismiss } = useCopilotRuntime();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function choose(action: "install" | "acknowledge", existing = false) {
    if (working) return;
    setWorking(true);
    setError(null);
    if (action === "acknowledge") onClose();
    try {
      // Recheck before presenting an installation action: another window may have completed setup.
      if (action === "install") {
        const status = await act({ action: "status" });
        if (!status.available) await act({ action });
        else await act({ action: "acknowledge" });
      } else await dismiss();
      onClose();
      if (existing)
        await navigate({
          href: `/settings/providers?providers=${encodeURIComponent(JSON.stringify(["copilot"]))}`,
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (action === "acknowledge")
        onFailure(
          `Could not remember Copilot setup preference: ${message}. Will retry when connected.`,
        );
      else setError(message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) void choose("acknowledge");
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogTitle>Do you use GitHub Copilot?</DialogTitle>
        <DialogDescription>
          Install the GitHub Copilot runtime to use Copilot in bigbud. You can also install it later
          in Settings → Providers → GitHub Copilot.
        </DialogDescription>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={working} onClick={() => void choose("install")}>
            Install Copilot
          </Button>
          <Button variant="outline" disabled={working} onClick={() => void choose("acknowledge")}>
            Set up later
          </Button>
          <Button
            variant="ghost"
            disabled={working}
            onClick={() => void choose("acknowledge", true)}
          >
            Use existing installation
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
