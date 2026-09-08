import { useSettings } from "~/hooks/useSettings";
import { TriangleAlertIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { StatusBanner } from "../../common/StatusBanner";
import { ContextWindowRecoveryActions } from "./ContextWindowRecoveryActions";
import {
  type ContextWindowSnapshot,
  formatContextWindowTokens,
  getContextWindowWarningRearmTokens,
} from "~/lib/contextWindow";

export const ContextWindowWarningBanner = memo(function ContextWindowWarningBanner({
  threadId,
  usage,
  handoffAvailable,
  onUseHandoff,
}: {
  threadId: string;
  usage: ContextWindowSnapshot | null;
  handoffAvailable: boolean;
  onUseHandoff: () => void;
}) {
  const settings = useSettings();
  const warningThreshold = settings.contextWindowWarningThresholdTokens;
  const [dismissUntilByThreadId, setDismissUntilByThreadId] = useState<Record<string, number>>({});

  const isOverThreshold = (usage?.usedTokens ?? 0) >= warningThreshold;
  const dismissUntilTokens = dismissUntilByThreadId[threadId];
  const isDismissed =
    dismissUntilTokens !== undefined && usage !== null && usage.usedTokens < dismissUntilTokens;

  useEffect(() => {
    if (dismissUntilTokens === undefined) {
      return;
    }
    if (!isOverThreshold || (usage?.usedTokens ?? 0) >= dismissUntilTokens) {
      setDismissUntilByThreadId(({ [threadId]: _, ...dismissals }) => dismissals);
    }
  }, [dismissUntilTokens, isOverThreshold, threadId, usage?.usedTokens]);

  if (!usage || !isOverThreshold || isDismissed) {
    return null;
  }

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <StatusBanner
        variant="warning"
        icon={<TriangleAlertIcon />}
        title="Context window warning"
        description={
          <>
            Some models may start deteriorating past {formatContextWindowTokens(warningThreshold)}{" "}
            tokens. Consider using handoff.
            <ContextWindowRecoveryActions
              handoffAvailable={handoffAvailable}
              onUseHandoff={onUseHandoff}
            />
          </>
        }
        onDismiss={() =>
          setDismissUntilByThreadId((dismissals) => ({
            ...dismissals,
            [threadId]: getContextWindowWarningRearmTokens(usage.usedTokens, warningThreshold),
          }))
        }
      />
    </div>
  );
});
