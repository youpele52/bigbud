import { memo } from "react";
import { type PendingApproval } from "../../../logic/session";
import { describePendingApproval } from "./pendingApproval";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary = describePendingApproval(approval).summary;

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
          PENDING APPROVAL
        </span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
    </div>
  );
});
