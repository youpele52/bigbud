import { describePendingApproval } from "@bigbud/ui/pendingApprovalCopy";
import {
  PendingApprovalHeader,
  pendingApprovalSurfaceStyles,
} from "@bigbud/ui/pendingApprovalSurface";
import type { MobilePendingApproval } from "../../../../lib/mobileModels";

export function MobileComposerApproval({ approval }: { readonly approval: MobilePendingApproval }) {
  const copy = describePendingApproval(approval);
  return (
    <div aria-label="Pending approval" className="max-h-48 overflow-y-auto" role="region">
      <PendingApprovalHeader summary={copy.summary} />
      <div className={pendingApprovalSurfaceStyles.body}>
        <p className={pendingApprovalSurfaceStyles.description}>{copy.description}</p>
        {approval.detail ? (
          <pre className={pendingApprovalSurfaceStyles.detail}>{approval.detail}</pre>
        ) : null}
      </div>
    </div>
  );
}
