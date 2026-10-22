import type { ThreadId } from "@bigbud/contracts";
import { Link } from "@tanstack/react-router";
import { GitForkIcon } from "lucide-react";
import { useMemo } from "react";

import type { Thread } from "../../../models/types/app.types";
import { ChatBanner } from "../common/ChatBanner";
import { Button } from "../../ui/button";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import {
  deriveForkOriginNotice,
  deriveSourceForkNotice,
  type ForkCarry,
} from "./ThreadForkNotice.logic";

const LINK_CLASS = "font-medium text-foreground underline underline-offset-2 hover:no-underline";

/**
 * Fork lineage notices: a fork names its source (with a link), and a source links the fork it
 * continued in. Blue (info): informational. While the source stays dead, a later message that
 * never reached the provider may follow the existing fork, only when the user asks (D20).
 */
export function ThreadForkNotice({
  thread,
  isForkPresent,
  onCarryToContinuedThread,
  carryPending = false,
}: {
  readonly thread: Pick<Thread, "id" | "forkOrigin" | "parentThread" | "messages" | "activities">;
  /** Deleted or unknown forks are not linked (see `useForkPresence`). */
  readonly isForkPresent: (forkThreadId: string) => boolean;
  readonly onCarryToContinuedThread?:
    | ((forkThreadId: ThreadId, carry: ForkCarry) => void)
    | undefined;
  readonly carryPending?: boolean;
}) {
  const { messages, activities } = thread;
  const origin = useMemo(
    () =>
      deriveForkOriginNotice({
        forkOrigin: thread.forkOrigin,
        parentThread: thread.parentThread,
        activities,
      }),
    [thread.forkOrigin, thread.parentThread, activities],
  );
  const sourceFork = useMemo(
    () => deriveSourceForkNotice({ messages, activities }, isForkPresent),
    [messages, activities, isForkPresent],
  );
  const { dismissed, dismiss } = useThreadNoticeDismissal(thread.id, "fork", [
    origin?.sourceThreadId ?? sourceFork?.forkThreadId,
  ]);
  if ((!origin && !sourceFork) || dismissed) return null;
  const carry = sourceFork?.carry ?? null;
  return (
    <>
      {origin ? (
        <ChatBanner
          variant={origin.tone}
          role="status"
          data-fork-notice="origin"
          data-tone={origin.tone}
          icon={<GitForkIcon aria-hidden />}
          title={
            <>
              Continued from{" "}
              <Link
                to="/$threadId"
                params={{ threadId: origin.sourceThreadId }}
                className={LINK_CLASS}
              >
                {origin.sourceTitle}
              </Link>
            </>
          }
          description={origin.description}
          dismissLabel="Dismiss continuation notice"
          onDismiss={dismiss}
        />
      ) : sourceFork ? (
        <ChatBanner
          variant="info"
          role="status"
          data-fork-notice="source"
          icon={<GitForkIcon aria-hidden />}
          title={
            sourceFork.automatic
              ? "This thread could not be resumed and continued in a new thread"
              : "This thread continued in a new thread"
          }
          description={
            <>
              <Link
                to="/$threadId"
                params={{ threadId: sourceFork.forkThreadId }}
                className={LINK_CLASS}
              >
                Open the continued thread
              </Link>
              {carry ? " Your latest message did not reach the provider." : null}
            </>
          }
          dismissLabel="Dismiss continuation notice"
          onDismiss={dismiss}
          action={
            carry && onCarryToContinuedThread ? (
              <Button
                size="sm"
                variant="outline"
                disabled={carryPending}
                onClick={() => onCarryToContinuedThread(sourceFork.forkThreadId, carry)}
              >
                Send this message to the continued thread
              </Button>
            ) : null
          }
        />
      ) : null}
    </>
  );
}
