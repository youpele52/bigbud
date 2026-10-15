import { CircleCheckIcon, LoaderCircleIcon, TriangleAlertIcon, XCircleIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Thread } from "../../../models/types/app.types";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import {
  deriveThreadRecoveryNotice,
  type ThreadRecoveryNoticeTone,
} from "./ThreadRecoveryNotice.logic";

const NOTICE_ICONS: Record<ThreadRecoveryNoticeTone, typeof CircleCheckIcon> = {
  info: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  error: XCircleIcon,
};

/** Blue "Reconnecting…" after 5 s without a started turn; green, amber or red outcome after. */
export function ThreadRecoveryNotice({
  thread,
}: {
  readonly thread: Pick<Thread, "turnStartRequest" | "activities">;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { notice, nextChangeInMs } = useMemo(
    () =>
      deriveThreadRecoveryNotice({
        request: thread.turnStartRequest,
        activities: thread.activities,
        nowMs,
      }),
    [nowMs, thread.activities, thread.turnStartRequest],
  );

  useEffect(() => {
    if (nextChangeInMs === null) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.max(0, nextChangeInMs));
    return () => window.clearTimeout(timer);
  }, [nextChangeInMs]);

  // A new request restarts the clock from the current time.
  useEffect(() => setNowMs(Date.now()), [thread.turnStartRequest]);

  if (!notice) return null;
  const Icon = NOTICE_ICONS[notice.tone];
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pt-3 sm:px-5">
      <Alert
        variant={notice.tone}
        role="status"
        aria-live="polite"
        data-recovery-notice={notice.kind}
      >
        <Icon className={notice.tone === "info" ? "animate-spin" : undefined} aria-hidden />
        <AlertTitle>{notice.title}</AlertTitle>
        <AlertDescription className="text-xs">{notice.description}</AlertDescription>
      </Alert>
    </div>
  );
}
