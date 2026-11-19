import { TerminalIcon } from "lucide-react";
import type { TerminalFinishedItem } from "@bigbud/contracts/workspace/terminal.activity.ts";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { presentTerminalFinished } from "./Sidebar.terminalFinished.logic";

/** Needs you line for finished terminal work: "`npm test` · exit 1 · 4m". */
export function SidebarTerminalFinishedLine(props: {
  items: ReadonlyArray<TerminalFinishedItem> | undefined;
}) {
  const presentation = presentTerminalFinished(props.items);
  if (!presentation) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/70"
      data-testid="thread-terminal-finished"
    >
      <TerminalIcon
        aria-hidden="true"
        className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/60`}
      />
      <code className="min-w-0 truncate font-mono">{presentation.command}</code>
      <span className={presentation.failed ? "shrink-0 text-destructive" : "shrink-0 text-success"}>
        {presentation.status}
      </span>
      <span className="shrink-0">{presentation.ago}</span>
      {presentation.more > 0 ? <span className="shrink-0">+{presentation.more}</span> : null}
    </span>
  );
}
