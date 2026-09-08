import type { ApprovalRequestId, ProviderApprovalDecision } from "@bigbud/contracts";

export interface PendingApprovalAction {
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
  readonly variant: "default" | "ghost" | "outline";
}

export function getPendingApprovalActions(input: {
  readonly requestId: ApprovalRequestId;
  readonly sessionApprovalAvailable?: boolean | undefined;
  readonly sessionApprovalLabel?: string | undefined;
}): ReadonlyArray<PendingApprovalAction> {
  const isLearningSkillProposal = input.requestId.startsWith("learning-skill:");
  return [
    {
      decision: "decline",
      label: isLearningSkillProposal ? "Reject patch" : "Decline",
      variant: "ghost",
    },
    ...(!isLearningSkillProposal
      ? ([{ decision: "cancel", label: "Cancel turn", variant: "ghost" }] as const)
      : []),
    ...(input.sessionApprovalAvailable !== false
      ? [
          {
            decision: "acceptForSession",
            label: input.sessionApprovalLabel ?? "Always allow this session",
            variant: "outline",
          } as const,
        ]
      : []),
    {
      decision: "accept",
      label: isLearningSkillProposal ? "Approve patch" : "Approve once",
      variant: "default",
    },
  ];
}
