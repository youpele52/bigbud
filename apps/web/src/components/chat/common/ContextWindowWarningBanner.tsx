import { useSettings } from "~/hooks/useSettings";
import { TriangleAlertIcon } from "lucide-react";
import { memo, useEffect } from "react";
import { useContextWindowDismissalStore } from "../../../stores/ui/contextWindowDismissal.store";
import { ChatBanner } from "./ChatBanner";
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
  const dismissUntilTokens = useContextWindowDismissalStore((state) =>
    state.rearmTokensByThread.get(threadId),
  );
  const setRearmTokens = useContextWindowDismissalStore((state) => state.setRearmTokens);

  const isOverThreshold = (usage?.usedTokens ?? 0) >= warningThreshold;
  const isDismissed =
    dismissUntilTokens !== undefined && usage !== null && usage.usedTokens < dismissUntilTokens;

  useEffect(() => {
    if (dismissUntilTokens === undefined) {
      return;
    }
    if (!isOverThreshold || (usage?.usedTokens ?? 0) >= dismissUntilTokens) {
      setRearmTokens(threadId, undefined);
    }
  }, [dismissUntilTokens, isOverThreshold, threadId, usage?.usedTokens, setRearmTokens]);

  if (!usage || !isOverThreshold || isDismissed) {
    return null;
  }

  return (
    <ChatBanner
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
        setRearmTokens(
          threadId,
          getContextWindowWarningRearmTokens(usage.usedTokens, warningThreshold),
        )
      }
    />
  );
});
