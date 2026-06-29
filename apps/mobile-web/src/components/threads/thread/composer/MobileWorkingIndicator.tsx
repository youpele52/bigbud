import { SpinnerVerbShimmer } from "~/components/chat/common/SpinnerVerbShimmer";
import { formatWorkingTimer } from "~/components/chat/messages/MessagesTimeline.assistantMessage.meta";

interface MobileWorkingIndicatorProps {
  verb: string;
  activeWorkStartedAt: string | null;
  nowIso: string;
}

export function MobileWorkingIndicator({
  verb,
  activeWorkStartedAt,
  nowIso,
}: MobileWorkingIndicatorProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-1">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className="flex items-center gap-2 px-3 py-1 text-[11px] text-muted-foreground/70"
          role="status"
        >
          <SpinnerVerbShimmer trailingEllipsis workingColor verb={verb} />
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
