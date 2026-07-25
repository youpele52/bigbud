import { useSettings } from "~/hooks/useSettings";
import { TriangleAlertIcon, XIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../ui/alert";
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
  compactAvailable,
  onUseHandoff,
  onCompact,
}: {
  threadId: string;
  usage: ContextWindowSnapshot | null;
  handoffAvailable: boolean;
  compactAvailable: boolean;
  onUseHandoff: () => void;
  onCompact: () => void;
}) {
  const settings = useSettings();
  const warningThreshold = settings.contextWindowWarningThresholdTokens;
  const [dismissedAtByThreadId, setDismissedAtByThreadId] = useState<Record<string, number>>({});

  const isOverThreshold = (usage?.usedTokens ?? 0) >= warningThreshold;
  const warningRearmTokens = getContextWindowWarningRearmTokens(warningThreshold);
  const dismissedAtTokens = dismissedAtByThreadId[threadId];
  const isDismissed =
    dismissedAtTokens !== undefined && usage !== null && usage.usedTokens < dismissedAtTokens;

  useEffect(() => {
    if (!isOverThreshold || (usage?.usedTokens ?? 0) >= warningRearmTokens) {
      setDismissedAtByThreadId(({ [threadId]: _, ...dismissals }) => dismissals);
    }
  }, [isOverThreshold, threadId, usage?.usedTokens, warningRearmTokens]);

  if (!usage || !isOverThreshold || isDismissed) {
    return null;
  }

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>Context window warning</AlertTitle>
        <AlertDescription>
          Some models may start deteriorating past {formatContextWindowTokens(warningThreshold)}{" "}
          tokens. Consider using handoff or /compact.
          <ContextWindowRecoveryActions
            handoffAvailable={handoffAvailable}
            compactAvailable={compactAvailable}
            onUseHandoff={onUseHandoff}
            onCompact={onCompact}
          />
        </AlertDescription>
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss"
            className="inline-flex size-6 items-center justify-center rounded-md text-warning/60 transition-colors hover:text-warning"
            onClick={() =>
              setDismissedAtByThreadId((dismissals) => ({
                ...dismissals,
                [threadId]: warningRearmTokens,
              }))
            }
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      </Alert>
    </div>
  );
});
