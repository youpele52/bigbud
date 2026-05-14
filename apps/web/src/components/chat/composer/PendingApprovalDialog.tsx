import { memo, useEffect, useMemo, useRef, useState } from "react";
import { type ApprovalRequestId, type ProviderApprovalDecision } from "@bigbud/contracts";

import { type PendingApproval } from "../../../logic/session";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { describePendingApproval } from "./pendingApproval";

interface PendingApprovalDialogProps {
  approval: PendingApproval;
  pendingCount: number;
  open: boolean;
  isResponding: boolean;
  projectName?: string | undefined;
  threadTitle: string;
  workingDirectory?: string | undefined;
  onOpenThread?: (() => void) | undefined;
  onOpenChange: (open: boolean) => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

export const PendingApprovalDialog = memo(function PendingApprovalDialog({
  approval,
  pendingCount,
  open,
  isResponding,
  projectName,
  threadTitle,
  workingDirectory,
  onOpenThread,
  onOpenChange,
  onRespondToApproval,
}: PendingApprovalDialogProps) {
  const approvalCopy = describePendingApproval(approval);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const autoApproveAfterMs = approval.autoApproveAfterMs;
  const requestId = approval.requestId;

  // Store the absolute deadline so that re-renders don't reset the countdown.
  // Key is `${requestId}:${autoApproveAfterMs}` — a new request or a changed
  // timeout both produce a fresh deadline.
  const deadlineRef = useRef<{ key: string; deadlineAt: number } | null>(null);
  const deadlineKey = `${requestId}:${autoApproveAfterMs}`;

  useEffect(() => {
    if (!open || autoApproveAfterMs === undefined || !requestId) {
      setSecondsRemaining(null);
      return;
    }

    // Re-anchor only when the request or its timeout changes, not on every render.
    if (!deadlineRef.current || deadlineRef.current.key !== deadlineKey) {
      deadlineRef.current = { key: deadlineKey, deadlineAt: Date.now() + autoApproveAfterMs };
    }
    const { deadlineAt } = deadlineRef.current;

    const updateCountdown = () => {
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      const nextSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
      setSecondsRemaining(nextSeconds);
      if (remainingMs === 0) {
        onOpenChange(false);
      }
    };

    updateCountdown();
    // 1 s interval — display updates once per second, matching the resolution
    // of the rendered countdown text.
    const interval = window.setInterval(updateCountdown, 1_000);
    return () => window.clearInterval(interval);
  }, [autoApproveAfterMs, deadlineKey, onOpenChange, open, requestId]);

  const autoApproveCopy = useMemo(() => {
    if (autoApproveAfterMs === undefined) {
      return null;
    }
    return `Auto-approves in ${secondsRemaining ?? Math.ceil(autoApproveAfterMs / 1000)}s unless you respond first.`;
  }, [autoApproveAfterMs, secondsRemaining]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isResponding) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-2xl" showCloseButton={!isResponding}>
        <DialogHeader>
          <DialogTitle>{approvalCopy.summary}</DialogTitle>
          <DialogDescription>
            {approvalCopy.description}
            {pendingCount > 1 ? ` This is request 1 of ${pendingCount}.` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {autoApproveCopy ? (
            <div className="rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm text-foreground">
              {autoApproveCopy}
            </div>
          ) : null}
          <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="font-medium text-sm">Request source</p>
              {onOpenThread ? (
                <Button size="sm" variant="outline" onClick={onOpenThread}>
                  Open thread
                </Button>
              ) : null}
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-[auto,1fr]">
              <dt className="text-muted-foreground">Thread</dt>
              <dd className="break-words">{threadTitle}</dd>
              {projectName ? (
                <>
                  <dt className="text-muted-foreground">Project</dt>
                  <dd className="break-words">{projectName}</dd>
                </>
              ) : null}
              {workingDirectory ? (
                <>
                  <dt className="text-muted-foreground">Directory</dt>
                  <dd className="break-all font-mono text-xs text-foreground">
                    {workingDirectory}
                  </dd>
                </>
              ) : null}
            </dl>
          </div>
          {approval.detail ? (
            <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
              <p className="mb-2 font-medium text-sm">Requested action</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                {approval.detail}
              </pre>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              Review and approve this request to let the agent continue.
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <ComposerPendingApprovalActions
            requestId={approval.requestId}
            isResponding={isResponding}
            sessionApprovalAvailable={approval.sessionApprovalAvailable}
            sessionApprovalLabel={approval.sessionApprovalLabel}
            onRespondToApproval={onRespondToApproval}
          />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
