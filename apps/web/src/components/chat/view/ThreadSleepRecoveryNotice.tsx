import { InfoIcon, LoaderCircleIcon, TriangleAlertIcon, XCircleIcon } from "lucide-react";

import type { Thread } from "../../../models/types/app.types";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import { Button } from "../../ui/button";
import { ChatBanner } from "../common/ChatBanner";
import {
  useResolveThreadRecovery,
  useSleepRecoveryNotice,
} from "./ThreadSleepRecoveryNotice.hooks";
import type { SleepRecoveryNotice } from "./ThreadSleepRecoveryNotice.logic";

function NoticeIcon({ notice }: { readonly notice: SleepRecoveryNotice }) {
  if (notice.kind === "resuming") return <LoaderCircleIcon className="animate-spin" aria-hidden />;
  if (notice.tone === "info") return <InfoIcon aria-hidden />;
  if (notice.tone === "warning") return <TriangleAlertIcon aria-hidden />;
  return <XCircleIcon aria-hidden />;
}

/**
 * Sleep and wake recovery: blue while bigbud resumes or the provider continued by itself, amber
 * when the outcome is unknown and the user decides, red once automatic attempts are parked.
 * The close button hides one state for this app run; the actions resolve it on the server.
 */
export function ThreadSleepRecoveryNotice({
  thread,
}: {
  readonly thread: Pick<Thread, "id" | "recovery">;
}) {
  const recovery = thread.recovery ?? null;
  const { notice, stateKey } = useSleepRecoveryNotice(thread.id, recovery);
  const { dismissed, dismiss } = useThreadNoticeDismissal(thread.id, "sleep-recovery", [stateKey]);
  const { resolve, pendingAction } = useResolveThreadRecovery(thread.id);

  if (!notice || !recovery || dismissed) return null;
  const informational = notice.tone === "info";
  return (
    <ChatBanner
      variant={notice.tone}
      role={informational ? "status" : "alert"}
      aria-live={informational ? "polite" : "assertive"}
      data-sleep-recovery-notice={notice.kind}
      icon={<NoticeIcon notice={notice} />}
      description={notice.description}
      dismissLabel="Dismiss sleep recovery notice"
      onDismiss={dismiss}
      action={
        notice.actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {notice.actions.map(({ action, label }, index) => (
              <Button
                key={action}
                size="sm"
                variant={index === 0 ? "default" : "outline"}
                disabled={pendingAction !== null}
                aria-busy={pendingAction === action}
                onClick={() => void resolve(recovery, action)}
              >
                {label}
              </Button>
            ))}
          </div>
        ) : null
      }
    />
  );
}
