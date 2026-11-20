import type { ApprovalRequestId, ProviderApprovalDecision } from "@bigbud/contracts";
import type { MobilePendingApproval } from "../../../../lib/mobileModels";
import { Button } from "../../../ui/button";

export function MobileComposerApprovalActions({
  approval,
  disabled,
  isLearningSkillProposal,
  onRespond,
}: {
  readonly approval: MobilePendingApproval;
  readonly disabled: boolean;
  readonly isLearningSkillProposal: boolean;
  readonly onRespond: (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      <Button
        className="min-h-11 text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={disabled}
        onClick={() => onRespond(approval.requestId, "decline")}
        size="sm"
        variant="outline"
      >
        {isLearningSkillProposal ? "Reject patch" : "Deny"}
      </Button>
      <Button
        className="min-h-11"
        disabled={disabled}
        onClick={() => onRespond(approval.requestId, "accept")}
        size="sm"
      >
        {isLearningSkillProposal ? "Approve patch" : "Approve"}
      </Button>
    </div>
  );
}
