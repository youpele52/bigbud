import { Button } from "../../../ui/button";
import { Dialog, DialogPopup } from "../../../ui/dialog";
import { Alert, AlertDescription } from "../../../ui/alert";
import { Loader2Icon } from "lucide-react";

export type ProviderSwitchBranchMode = "handoff" | "conversation";

export interface ProviderSwitchBranchModalProps {
  targetLabel: string;
  selectedMode: ProviderSwitchBranchMode;
  onSelectMode: (mode: ProviderSwitchBranchMode) => void;
  isGeneratingHandoff: boolean;
  handoffError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ProviderSwitchBranchModal({
  targetLabel,
  selectedMode,
  onSelectMode,
  isGeneratingHandoff,
  handoffError,
  onCancel,
  onConfirm,
}: ProviderSwitchBranchModalProps) {
  return (
    // Same shared Dialog as the welcome tour: a full-window translucent dim with no blur, so the
    // window stays translucent behind it while the popup itself is solid.
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isGeneratingHandoff) onCancel();
      }}
    >
      <DialogPopup className="max-w-sm" showCloseButton={false}>
        <ProviderSwitchBranchContent
          targetLabel={targetLabel}
          selectedMode={selectedMode}
          onSelectMode={onSelectMode}
          isGeneratingHandoff={isGeneratingHandoff}
          handoffError={handoffError}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      </DialogPopup>
    </Dialog>
  );
}

/** The dialog body, split out so it can be rendered and tested without the portal. */
export function ProviderSwitchBranchContent({
  targetLabel,
  selectedMode,
  onSelectMode,
  isGeneratingHandoff,
  handoffError,
  onCancel,
  onConfirm,
}: ProviderSwitchBranchModalProps) {
  return (
    <div className="space-y-4 p-5">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Start a new {targetLabel} branch?</h2>
        <p className="text-muted-foreground text-xs">
          Switching providers creates a branch. Choose how the new branch should start.
        </p>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          disabled={isGeneratingHandoff}
          onClick={() => onSelectMode("handoff")}
          className={`
              flex w-full flex-col items-start rounded-lg border p-3 text-left transition-colors
              ${
                selectedMode === "handoff"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-foreground/20"
              }
            `}
        >
          <span className="text-sm font-medium">Start with handoff summary</span>
          <span className="text-muted-foreground text-xs">
            Generate a handoff document in the background, then seed the new branch with only that
            summary.
          </span>
        </button>

        <button
          type="button"
          disabled={isGeneratingHandoff}
          onClick={() => onSelectMode("conversation")}
          className={`
              flex w-full flex-col items-start rounded-lg border p-3 text-left transition-colors
              ${
                selectedMode === "conversation"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-foreground/20"
              }
            `}
        >
          <span className="text-sm font-medium">Continue with conversation context</span>
          <span className="text-muted-foreground text-xs">
            Copy the existing conversation into the new branch as it is today.
          </span>
        </button>
      </div>

      {handoffError ? (
        <Alert variant="error" className="text-xs">
          <AlertDescription>{handoffError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={isGeneratingHandoff} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={isGeneratingHandoff} onClick={onConfirm}>
          {isGeneratingHandoff ? (
            <>
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
              Generating handoff…
            </>
          ) : (
            "Create branch"
          )}
        </Button>
      </div>
    </div>
  );
}
