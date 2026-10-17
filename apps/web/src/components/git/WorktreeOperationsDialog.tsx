import { useState } from "react";
import type { WorktreeOperationSummary } from "@bigbud/contracts/workspace/worktrees.ts";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { WorktreeIcon } from "./WorktreeIcon";

export function WorktreeOperationsDialog(props: {
  operations: readonly WorktreeOperationSummary[] | undefined;
  error: Error | null;
  onClose: () => void;
  onRecheck: (id: string) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null),
    [error, setError] = useState("");
  const recheck = async (id: string) => {
    setPending(id);
    setError("");
    try {
      await props.onRecheck(id);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(null);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WorktreeIcon />
            Worktree operations
          </DialogTitle>
          <DialogDescription>
            These durable records survive reloads. Recheck only applies verified outcomes; uncertain
            workspaces stay reserved. Nothing is forced or silently rolled back.
          </DialogDescription>
        </DialogHeader>
        {(error || props.error) && (
          <p role="alert" className="my-3 break-all text-sm text-destructive">
            {error || String(props.error)}
          </p>
        )}
        <div className="my-3 max-h-96 space-y-3 overflow-y-auto">
          {!props.operations && !props.error && (
            <p className="text-sm text-muted-foreground">Loading operations…</p>
          )}
          {props.operations?.length === 0 && (
            <p className="text-sm text-muted-foreground">No worktree operations recorded.</p>
          )}
          {props.operations?.map((operation) => (
            <section
              key={operation.operationId}
              className="space-y-1 rounded-md border p-3 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span>
                  {operation.kind === "access" ? "Workspace activity" : operation.kind} ·{" "}
                  {operation.phase}
                </span>
                {operation.canRecheck && (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={pending !== null}
                    onClick={() => void recheck(operation.operationId)}
                  >
                    {pending === operation.operationId ? "Checking…" : "Recheck operation"}
                  </Button>
                )}
              </div>
              <p className="select-text break-all text-xs text-muted-foreground">
                Operation: {operation.operationId}
              </p>
              <p className="select-text break-all text-xs text-muted-foreground">
                {operation.source}
                {operation.destination !== operation.source ? ` → ${operation.destination}` : ""}
              </p>
              {operation.error && (
                <p className="select-text break-all text-xs text-muted-foreground">
                  {operation.error}
                </p>
              )}
              {operation.kind === "access" && operation.phase !== "completed" && (
                <p className="text-xs text-amber-600">
                  Activity exit is unconfirmed. The reservation is retained for safe recovery by the
                  server owner.
                </p>
              )}
            </section>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending !== null} onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
