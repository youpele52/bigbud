import { memo } from "react";
import { ThreadNoticeBanner } from "../common/ThreadNoticeBanner";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
  planId,
  threadId,
}: {
  planTitle: string | null;
  planId: string;
  threadId: string;
}) {
  return (
    <ThreadNoticeBanner
      threadId={threadId}
      kind="plan-follow-up"
      scope={[planId]}
      role="status"
      title="Plan ready"
      description={planTitle}
      dismissLabel="Dismiss plan ready notice"
    />
  );
});
