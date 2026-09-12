import { Wifi } from "lucide-react";
import { useWsConnectionStatus } from "~/rpc/wsConnectionState";
import { resolveActivityStatus } from "./ActivityStatusIndicator.logic";
import { formatWorkingTimer } from "../messages/MessagesTimeline.assistantMessage.meta";

import { SpinnerVerbShimmer } from "./SpinnerVerbShimmer";

function WorkingDots() {
  return (
    <span className="inline-flex items-center gap-[3px] leading-none">
      <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30" />
      <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30 [animation-delay:200ms]" />
      <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30 [animation-delay:400ms]" />
    </span>
  );
}

interface ActivityStatusIndicatorProps {
  verb: string;
  isCompacting: boolean;
  activeWorkStartedAt: string | null;
  nowIso: string;
}

export function ActivityStatusIndicator({
  verb,
  isCompacting,
  activeWorkStartedAt,
  nowIso,
}: ActivityStatusIndicatorProps) {
  const connection = useWsConnectionStatus();
  const status = resolveActivityStatus({ connection, isCompacting, verb });
  return (
    <div className="pointer-events-none absolute bottom-1 left-0 right-0 flex justify-center px-5">
      <div className="mx-auto w-full max-w-3xl px-1 py-0.5">
        <div
          className="flex items-center gap-2 rounded-md bg-transparent px-7 pt-1 pb-1 text-[11px] text-muted-foreground/70"
          role="status"
        >
          {status.kind === "working" ? (
            <>
              <SpinnerVerbShimmer verb={status.label} />
              <WorkingDots />
            </>
          ) : (
            <span className="inline-flex items-center gap-2 leading-none text-warning">
              {status.kind === "reconnecting" ? (
                <Wifi className="size-3.5 shrink-0" aria-hidden="true" />
              ) : null}
              {status.label}
            </span>
          )}
          <span className="flex-1" />
          {activeWorkStartedAt ? (
            <span className="leading-none">
              {formatWorkingTimer(activeWorkStartedAt, nowIso) ?? "0s"}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
