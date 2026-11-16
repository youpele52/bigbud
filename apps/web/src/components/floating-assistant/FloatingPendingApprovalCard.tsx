import type { ApprovalRequestId, ProviderApprovalDecision } from "@bigbud/contracts";
import {
  PendingApprovalHeader,
  pendingApprovalSurfaceStyles,
} from "@bigbud/ui/pendingApprovalSurface";

import { getPendingApprovalActions } from "~/components/chat/composer/pendingApprovalActions.logic";
import { describePendingApproval } from "~/components/chat/composer/pendingApproval";
import { Button } from "~/components/ui/button";
import type { PendingApproval } from "~/logic/session";

export function FloatingPendingApprovalCard({
  approval,
  isResponding,
  onRespondToApproval,
}: {
  readonly approval: PendingApproval;
  readonly isResponding: boolean;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}) {
  const copy = describePendingApproval(approval);
  const actions = getPendingApprovalActions(approval);

  return (
    <section className={pendingApprovalSurfaceStyles.frame}>
      <PendingApprovalHeader summary={copy.summary} />
      <div className={pendingApprovalSurfaceStyles.body}>
        <p className={pendingApprovalSurfaceStyles.description}>{copy.description}</p>
        {approval.detail ? (
          <pre className={pendingApprovalSurfaceStyles.detail}>{approval.detail}</pre>
        ) : null}
        <div className="grid grid-cols-2 gap-1.5 pt-0.5">
          {actions.map((action) => (
            <Button
              key={action.decision}
              size="sm"
              variant={action.variant}
              disabled={isResponding}
              className={
                action.decision === "decline"
                  ? "h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1.5 text-xs leading-tight text-destructive hover:text-destructive"
                  : "h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1.5 text-xs leading-tight"
              }
              onClick={() => void onRespondToApproval(approval.requestId, action.decision)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </section>
  );
}
