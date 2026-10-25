import { useSettings } from "~/hooks/useSettings";
import { TriangleAlertIcon } from "lucide-react";
import { memo } from "react";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import { ChatBanner } from "./ChatBanner";
import { ContextWindowRecoveryActions } from "./ContextWindowRecoveryActions";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";

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
  const { dismissed, dismiss } = useThreadNoticeDismissal(threadId, "context-window");
  if (!usage || usage.usedTokens < warningThreshold || dismissed) return null;

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
      onDismiss={dismiss}
    />
  );
});
