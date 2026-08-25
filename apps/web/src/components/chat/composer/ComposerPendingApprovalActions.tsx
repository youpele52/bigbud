import { type ApprovalRequestId, type ProviderApprovalDecision } from "@bigbud/contracts";
import { memo } from "react";
import { Button } from "../../ui/button";
import { getPendingApprovalActions } from "./pendingApprovalActions.logic";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  sessionApprovalAvailable?: boolean | undefined;
  sessionApprovalLabel?: string | undefined;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  sessionApprovalAvailable,
  sessionApprovalLabel,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const actions = getPendingApprovalActions({
    requestId,
    sessionApprovalAvailable,
    sessionApprovalLabel,
  });
  return (
    <>
      {actions.map((action) => (
        <Button
          key={action.decision}
          size="sm"
          variant={action.variant}
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, action.decision)}
          className={
            action.decision === "decline"
              ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
              : undefined
          }
        >
          {action.label}
        </Button>
      ))}
    </>
  );
});
