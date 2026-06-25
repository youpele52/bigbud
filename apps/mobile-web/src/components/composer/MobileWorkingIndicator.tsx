import { formatWorkingTimer } from "~/components/chat/messages/MessagesTimeline.assistantMessage.meta";

function WorkingDots() {
  return (
    <span className="inline-flex items-center gap-[3px] leading-none">
      <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30" />
      <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30 [animation-delay:200ms]" />
      <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30 [animation-delay:400ms]" />
    </span>
  );
}

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
        <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-muted-foreground/70">
          <span className="leading-none">{verb}</span>
          <WorkingDots />
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
