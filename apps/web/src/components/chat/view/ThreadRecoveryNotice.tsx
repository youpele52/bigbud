import { CircleCheckIcon, LoaderCircleIcon, TriangleAlertIcon, XCircleIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Thread } from "../../../models/types/app.types";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import { observeThreadTurnStartRequest } from "./ThreadRecoveryNotice.clock";
import { deriveServerTurnFailure } from "./ThreadRecoveryNotice.failure";
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

/**
 * Blue "Reconnecting…" after 5 s without a started turn; green, amber or red outcome after.
 * While waiting or after a failure it offers "Continue in a new thread" (server-side fork); a
 * fork-only failure is read from server state, so the offer survives a reload.
 */
export function ThreadRecoveryNotice({
  thread,
  onContinueInNewThread,
  continuePending = false,
}: {
  readonly thread: Pick<Thread, "id" | "turnStartRequest" | "messages" | "activities">;
  /** Omitted when the thread already continued in a fork. */
  readonly onContinueInNewThread?: (() => void) | undefined;
  readonly continuePending?: boolean;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { id: threadId, turnStartRequest, messages, activities } = thread;
  // Durations use only this browser's clock: when it first saw the request and its settlement.
  const clock = useMemo(
    () => observeThreadTurnStartRequest(threadId, turnStartRequest, Date.now()),
    [threadId, turnStartRequest],
  );
  const failure = useMemo(
    () => deriveServerTurnFailure({ messages, activities }),
    [messages, activities],
  );
  const { notice, nextChangeInMs } = useMemo(
    () => deriveThreadRecoveryNotice({ request: turnStartRequest, clock, failure, nowMs }),
    [clock, failure, nowMs, turnStartRequest],
  );

  useEffect(() => {
    if (nextChangeInMs === null) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.max(0, nextChangeInMs));
    return () => window.clearTimeout(timer);
  }, [nextChangeInMs]);

  // A new request restarts the clock from the current time.
  useEffect(() => setNowMs(Date.now()), [turnStartRequest]);

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
        {notice.canContinueInNewThread && onContinueInNewThread ? (
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              disabled={continuePending}
              onClick={onContinueInNewThread}
            >
              Continue in a new thread
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
}
