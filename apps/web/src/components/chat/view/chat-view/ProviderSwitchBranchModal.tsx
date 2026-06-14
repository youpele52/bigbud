import { Button } from "../../../ui/button";
import { Card } from "../../../ui/card";
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
    <div className="absolute inset-0 z-20 flex items-center justify-center px-4 py-6">
      <button
        type="button"
        aria-label="Dismiss provider switch confirmation"
        className="absolute inset-0 bg-background/60 backdrop-blur-[1px]"
        onClick={onCancel}
      />
      <Card className="relative w-full max-w-sm border-border/80 bg-background/96 p-5 shadow-lg/10">
        <div className="space-y-4">
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
                Run the curated handoff skill on this thread, then copy only the summary into the
                new branch.
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
            <div className="rounded-md border border-destructive/32 bg-destructive/4 px-3 py-2 text-xs text-destructive">
              {handoffError}
            </div>
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
      </Card>
    </div>
  );
}
