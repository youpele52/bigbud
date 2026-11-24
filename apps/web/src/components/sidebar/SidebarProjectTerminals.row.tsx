import type { ThreadId } from "@bigbud/contracts";
import { TimerResetIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { TerminalStateStoreState } from "../../stores/terminal/terminal.store.types";
import { terminalAgentIcon, terminalAgentName } from "../terminal/terminalAgentIcons";
import { resolveTerminalAgentKind } from "../terminal/terminalAgentKind.resolve";
import { terminalPaneLabel } from "../terminal/terminalPaneLabel";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  projectTerminalDetailText,
  projectTerminalLocationText,
  projectTerminalStateLabel,
  type ProjectTerminalIdentity,
  type ProjectTerminalRow,
  type ProjectTerminalState,
} from "./SidebarProjectTerminals.logic";

const DOT_CLASS: Record<ProjectTerminalState, string> = {
  busy: "bg-info animate-pulse motion-reduce:animate-none",
  idle: "bg-muted-foreground/50",
  closing: "bg-warning",
};

/** The user's rename wins, then the running agent's name, then the tab label. */
export function identifyTerminal(
  store: TerminalStateStoreState,
  threadId: ThreadId,
  terminalId: string,
): ProjectTerminalIdentity {
  const agent = resolveTerminalAgentKind(store, threadId, terminalId);
  const rename = store.terminalLabelOverridesByThreadId[threadId]?.[terminalId]?.trim();
  if (rename) return { title: rename, agent };
  if (agent) return { title: terminalAgentName(agent), agent };
  return { title: terminalPaneLabel(store, threadId, terminalId), agent };
}

/** A row action as an icon; the label is its tooltip and accessible name. */
function IconAction({
  label,
  destructive = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            className={destructive ? "hover:text-destructive" : undefined}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One terminal: dot, agent logo and name, actions. Clicking the name shows the terminal full
 * screen; hovering it shows where it lives
 * (group and thread); the second line appears only for an idle-close countdown.
 */
export function ProjectTerminalRowView({
  row,
  muted = false,
  onShow,
  onClose,
  onKeep,
}: {
  readonly row: ProjectTerminalRow;
  readonly muted?: boolean;
  readonly onShow: () => void;
  readonly onClose: () => void;
  readonly onKeep: () => void;
}) {
  const AgentIcon = row.agent ? terminalAgentIcon(row.agent) : null;
  const detail = projectTerminalDetailText(row);
  return (
    <div className="-mx-2 flex items-center gap-2 rounded-md px-2 py-0.5 hover:bg-accent">
      <span
        role="img"
        aria-label={projectTerminalStateLabel(row.state)}
        title={projectTerminalStateLabel(row.state)}
        className={`size-2 shrink-0 rounded-full ${DOT_CLASS[row.state]}`}
      />
      <div className="min-w-0 flex-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Show ${row.title}`}
                onClick={onShow}
                className={`flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring ${muted ? "text-muted-foreground" : ""}`}
              />
            }
          >
            {AgentIcon ? <AgentIcon aria-hidden="true" className="size-3 shrink-0" /> : null}
            <span className="truncate">{row.title}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">{projectTerminalLocationText(row)}</TooltipPopup>
        </Tooltip>
        {detail ? <div className="truncate text-xs text-muted-foreground">{detail}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {row.state === "closing" ? (
          <IconAction label="Keep open" onClick={onKeep}>
            <TimerResetIcon />
          </IconAction>
        ) : null}
        <IconAction label="Close terminal" destructive onClick={onClose}>
          <XIcon />
        </IconAction>
      </div>
    </div>
  );
}
