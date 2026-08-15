import { useEffect, useState } from "react";

export const SIDEBAR_CONNECTING_LABEL_DELAY_MS = 10_000;

function connectingLabelDelayMs(connectingStartedAt: string, now = Date.now()): number {
  const startedAt = Date.parse(connectingStartedAt);
  if (!Number.isFinite(startedAt)) return SIDEBAR_CONNECTING_LABEL_DELAY_MS;

  return Math.min(
    SIDEBAR_CONNECTING_LABEL_DELAY_MS,
    Math.max(0, SIDEBAR_CONNECTING_LABEL_DELAY_MS - (now - startedAt)),
  );
}

export function SidebarThreadConnectingIndicator({
  connectingStartedAt,
}: {
  connectingStartedAt: string;
}) {
  const [revealedEpisodeStartedAt, setRevealedEpisodeStartedAt] = useState<string | null>(() =>
    connectingLabelDelayMs(connectingStartedAt) === 0 ? connectingStartedAt : null,
  );
  const labelIsVisible =
    revealedEpisodeStartedAt === connectingStartedAt ||
    connectingLabelDelayMs(connectingStartedAt) === 0;

  useEffect(() => {
    const delayMs = connectingLabelDelayMs(connectingStartedAt);
    if (delayMs === 0) return;

    const timeout = window.setTimeout(() => {
      setRevealedEpisodeStartedAt(connectingStartedAt);
    }, delayMs);

    return () => window.clearTimeout(timeout);
  }, [connectingStartedAt]);

  return (
    <span className={labelIsVisible ? "shrink-0 text-[10px] text-warning" : "sr-only"}>
      connecting
    </span>
  );
}
