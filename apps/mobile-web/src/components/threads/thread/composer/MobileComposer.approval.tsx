import type { MobilePendingApproval } from "../../../../lib/mobileModels";
import { cn } from "../../../../lib/cn";

export function MobileComposerApproval({
  approval,
  isLearningSkillProposal,
}: {
  readonly approval: MobilePendingApproval;
  readonly isLearningSkillProposal: boolean;
}) {
  return (
    <div
      aria-label="Pending approval"
      className="grid max-h-48 gap-1.5 overflow-y-auto border-b border-border/60 px-3 py-3"
      role="region"
    >
      <p className="text-[11px] font-semibold tracking-widest text-muted-foreground/60 uppercase">
        Pending approval
      </p>
      <p className="text-sm font-medium text-foreground">
        {isLearningSkillProposal ? "Skill improvement suggested" : approval.requestKind}
      </p>
      {approval.detail ? (
        <p
          className={cn(
            "max-h-28 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground",
          )}
        >
          {approval.detail}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">Choose an explicit decision to continue.</p>
    </div>
  );
}
