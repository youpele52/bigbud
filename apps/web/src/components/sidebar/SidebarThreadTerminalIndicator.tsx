import { TerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { selectThreadSurfacePanes, useTerminalStateStore } from "../../stores/terminal";
import {
  selectThreadTerminalLiveness,
  useTerminalLivenessStore,
} from "../../stores/terminal/terminalLiveness.store";
import {
  hasPendingIdleWarning,
  livenessForThreadPanes,
  TERMINAL_LIVENESS_REFRESH_MS,
  terminalStatusFromLiveness,
  type TerminalStatusIndicator,
} from "./SidebarThreadRow.status";

/** Re-renders on a slow clock only while an idle warning's countdown is shown. */
function useLivenessRefresh(ticking: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), TERMINAL_LIVENESS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [ticking]);
}

/**
 * The row's terminal glyph. Finished terminal work (`finished`, in Needs you) keeps priority;
 * otherwise it shows the thread's live terminals from the server inventory (plan §11.2), limited
 * to the thread's panes when it has any.
 */
export function SidebarThreadTerminalIndicator({
  threadId,
  finished,
}: {
  readonly threadId: string;
  readonly finished: TerminalStatusIndicator | null;
}) {
  const threadLiveness = useTerminalLivenessStore((state) =>
    selectThreadTerminalLiveness(state, threadId),
  );
  const panes = useTerminalStateStore(
    useShallow((state) => selectThreadSurfacePanes(state, threadId)),
  );
  const liveness = livenessForThreadPanes(threadLiveness, panes);
  // Read on every render; the refresh only schedules renders while a countdown is visible.
  const now = Date.now();
  useLivenessRefresh(finished === null && hasPendingIdleWarning(liveness, now));
  const status = finished ?? terminalStatusFromLiveness(liveness, now);
  if (!status) return null;
  return (
    <span
      data-slot="thread-terminal-indicator"
      role="img"
      aria-label={status.label}
      title={status.label}
      className={`inline-flex items-center justify-center ${status.colorClass}`}
    >
      <TerminalIcon
        aria-hidden="true"
        className={`size-3 ${status.pulse ? "animate-pulse motion-reduce:animate-none" : ""}`}
      />
    </span>
  );
}
