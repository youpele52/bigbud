import type { ReactElement } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { terminalActivityHoverLine, threadHoverSummary } from "./SidebarThreadRow.hover.logic";

/**
 * The row's hover card: the elevator summary, plus the last terminal activity. Either line may
 * appear alone; with neither, the row renders without a hover card.
 */
export function SidebarThreadRowHover(props: {
  thread: {
    readonly title: string;
    readonly elevatorSummary?: string | null | undefined;
    readonly latestTerminalActivityAt?: string | null | undefined;
  };
  children: ReactElement;
}) {
  const summary = threadHoverSummary(props.thread);
  const terminalLine = terminalActivityHoverLine(props.thread.latestTerminalActivityAt);
  if (!summary && !terminalLine) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="w-full" />}>{props.children}</TooltipTrigger>
      <TooltipPopup side="right" className="max-w-72 whitespace-normal text-xs leading-snug">
        {summary}
        {terminalLine ? (
          <div
            className={`flex items-baseline justify-between gap-3${summary ? " mt-1 text-muted-foreground" : ""}`}
          >
            <span>{terminalLine.label}</span>
            <span className="shrink-0 tabular-nums">{terminalLine.time}</span>
          </div>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}
