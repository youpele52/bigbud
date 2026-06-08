import { TriangleAlertIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../ui/alert";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";

const BANNER_THRESHOLD = 120_000;

export const ContextWindowWarningBanner = memo(function ContextWindowWarningBanner({
  usage,
}: {
  usage: ContextWindowSnapshot | null;
}) {
  const [dismissed, setDismissed] = useState(false);
  const prevKeyRef = useRef<string | null>(null);

  const isOverThreshold = (usage?.usedTokens ?? 0) >= BANNER_THRESHOLD;
  const key = usage ? `${usage.usedTokens}:${usage.maxTokens ?? 0}` : null;

  // Re-show the banner when the token count changes significantly (crosses the threshold)
  useEffect(() => {
    if (isOverThreshold && key !== prevKeyRef.current) {
      setDismissed(false);
      prevKeyRef.current = key;
    }
  }, [key, isOverThreshold]);

  if (!usage || !isOverThreshold || dismissed) {
    return null;
  }

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>Context window warning</AlertTitle>
        <AlertDescription>
          Some models may start deteriorating past {formatContextWindowTokens(BANNER_THRESHOLD)}{" "}
          tokens. Consider using a handoff skill or /compact.
        </AlertDescription>
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss"
            className="inline-flex size-6 items-center justify-center rounded-md text-warning/60 transition-colors hover:text-warning"
            onClick={() => setDismissed(true)}
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      </Alert>
    </div>
  );
});
