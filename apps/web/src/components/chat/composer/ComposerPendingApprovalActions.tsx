import { type ApprovalRequestId, type ProviderApprovalDecision } from "@bigbud/contracts";
import { memo } from "react";
import { Button } from "../../ui/button";

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
  const isLearningSkillProposal = requestId.startsWith("learning-skill:");
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        {isLearningSkillProposal ? "Reject patch" : "Decline"}
      </Button>
      {!isLearningSkillProposal ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "cancel")}
        >
          Cancel turn
        </Button>
      ) : null}
      {sessionApprovalAvailable !== false ? (
        <Button
          size="sm"
          variant="outline"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
        >
          {sessionApprovalLabel ?? "Always allow this session"}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="default"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        {isLearningSkillProposal ? "Approve patch" : "Approve once"}
      </Button>
    </>
  );
});
