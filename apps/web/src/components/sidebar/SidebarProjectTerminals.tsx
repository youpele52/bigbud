import type { ThreadId } from "@bigbud/contracts";
import { TerminalIcon } from "lucide-react";
import { useEffect, useState, type SyntheticEvent } from "react";

import { useTerminalStateStore } from "../../stores/terminal";
import { revealExistingTerminal } from "../terminal/revealTerminal";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  closeAllProjectTerminals,
  closeIdleProjectTerminals,
  closeProjectTerminal,
  keepProjectTerminalOpen,
} from "./SidebarProjectTerminals.actions";
import { useTerminalThreads, type TerminalListScope } from "./SidebarProjectTerminals.hooks";
import {
  countProjectTerminals,
  idleProjectTerminals,
  projectTerminalRows,
  type ProjectTerminalRow,
} from "./SidebarProjectTerminals.logic";
import { identifyTerminal, ProjectTerminalRowView } from "./SidebarProjectTerminals.row";
import { TERMINAL_LIVENESS_REFRESH_MS } from "./SidebarThreadRow.status";

const NO_SCOPE: TerminalListScope = { kind: "none" };

/** The project header must not see clicks meant for the list (expand, drag, swipe). */
function stopHeader(event: SyntheticEvent) {
  event.stopPropagation();
}

/** Re-renders on a slow clock while the list is open, so "closes in" stays current. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TERMINAL_LIVENESS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [ticking]);
  return now;
}

/**
 * The project header's live-terminal count. Clicking it lists the project's running terminals by
 * thread, with open, close and keep-open actions. Hidden while the project has none.
 */
export function SidebarProjectTerminals({
  scope,
  title,
  executionTargetId,
  navigateToThread,
  otherScope,
}: {
  readonly scope: TerminalListScope;
  /** The project the list belongs to; omitted where the context already says it (Inyosira). */
  readonly title?: string | undefined;
  /** Close fallback only; each pane's own launch target is authoritative. */
  readonly executionTargetId?: string | undefined;
  readonly navigateToThread: (threadId: ThreadId) => void;
  /** Also list live terminals of threads outside `scope` (Present: ones left behind elsewhere). */
  readonly otherScope?: TerminalListScope | undefined;
}) {
  const [requestedOpen, setOpen] = useState(false);
  const threads = useTerminalThreads(scope);
  const otherThreads = useTerminalThreads(otherScope ?? NO_SCOPE);
  const count = countProjectTerminals(threads);
  // Open only while there is something to list: an empty list never reopens on its own later.
  const open = requestedOpen && count > 0;
  const now = useNow(open);
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);
  if (count === 0) return null;

  const store = useTerminalStateStore.getState();
  const toRows = (list: typeof threads) =>
    open
      ? projectTerminalRows({
          threads: list,
          identify: (threadId, terminalId) => identifyTerminal(store, threadId, terminalId),
          nowMs: now,
        })
      : [];
  const rows = toRows(threads);
  const otherRows = toRows(otherThreads);
  // One footer action for every idle row the popover lists, in either section.
  const allRows = [...rows, ...otherRows];
  const allIdle = idleProjectTerminals(allRows);
  const target = (row: ProjectTerminalRow) => ({
    threadId: row.threadId,
    terminalId: row.terminalId,
    executionTargetId,
  });
  const openRow = (row: ProjectTerminalRow) => {
    setOpen(false);
    revealExistingTerminal(row.threadId, row.terminalId, { fullscreen: true });
    navigateToThread(row.threadId);
  };
  const renderRow = (row: ProjectTerminalRow, muted: boolean) => (
    <ProjectTerminalRowView
      key={`${row.threadId}:${row.terminalId}`}
      row={row}
      muted={muted}
      onShow={() => openRow(row)}
      onClose={() => closeProjectTerminal(target(row))}
      onKeep={() => void keepProjectTerminalOpen(target(row))}
    />
  );
  const plural = count === 1 ? "terminal" : "terminals";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`${count} running ${plural}${title ? ` in ${title}` : ""}`}
        title={`${count} running ${plural}`}
        data-thread-selection-safe
        className="inline-flex h-4 shrink-0 cursor-pointer items-center gap-0.5 rounded-full border border-border px-1.5 text-xs leading-none font-medium text-muted-foreground tabular-nums transition-colors hover:bg-background hover:text-foreground"
        onPointerDown={stopHeader}
        onClick={stopHeader}
        onKeyDown={stopHeader}
        onContextMenu={stopHeader}
      >
        <TerminalIcon aria-hidden="true" className="size-2.5" />
        {count}
      </PopoverTrigger>
      <PopoverPopup
        side="right"
        align="start"
        className="w-80 max-h-96"
        // Focus the first row only when opened from the keyboard; a click shows no focus ring.
        initialFocus={(openType) => openType === "keyboard"}
        data-thread-selection-safe
        onPointerDown={stopHeader}
        onClick={stopHeader}
        onKeyDown={stopHeader}
        onContextMenu={stopHeader}
      >
        <div className="-my-2 flex flex-col gap-0.5 text-xs">
          <div className="flex items-baseline justify-between gap-2 pb-1">
            <span className="truncate font-medium">
              {title ? `Running terminals · ${title}` : "Running terminals"}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{count} live</span>
          </div>
          {rows.map((row) => renderRow(row, false))}
          {otherRows.length > 0 ? (
            <>
              <div className="mt-1 flex items-center justify-between gap-2 border-t border-border pt-2 text-muted-foreground">
                <span>In other threads ({otherRows.length})</span>
              </div>
              {otherRows.map((row) => renderRow(row, true))}
            </>
          ) : null}
          <div className="mt-1 flex items-center justify-end gap-2 border-t border-border pt-2">
            <Button
              size="xs"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setOpen(false);
                closeAllProjectTerminals(
                  allRows.map(target),
                  allRows.filter((row) => row.state === "busy").map((row) => row.title),
                );
              }}
            >
              Close all
            </Button>
            {allIdle.length > 0 ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => closeIdleProjectTerminals(allIdle.map(target))}
              >
                Close idle ({allIdle.length})
              </Button>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
