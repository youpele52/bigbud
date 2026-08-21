import type { ApprovalRequestId, ProviderApprovalDecision } from "@bigbud/contracts";
import { CircleAlertIcon } from "lucide-react";

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
    <section className="mx-auto w-full max-w-[calc(52rem*2/3)] overflow-hidden rounded-[20px] border border-warning/35 bg-warning/5 shadow-xs">
      <header className="flex items-start gap-2 border-b border-warning/20 px-3 py-2.5">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="font-medium text-sm text-foreground">Approval required</p>
          <p className="mt-0.5 text-muted-foreground text-xs">{copy.summary}</p>
        </div>
      </header>
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-muted-foreground text-xs leading-5">{copy.description}</p>
        {approval.detail ? (
          <pre className="max-h-28 overflow-auto rounded-lg border border-border/70 bg-muted/35 p-2 text-xs whitespace-pre-wrap break-words text-foreground">
            {approval.detail}
          </pre>
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
