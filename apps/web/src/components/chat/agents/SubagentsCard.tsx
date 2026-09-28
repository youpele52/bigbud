import { useState } from "react";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import { CompactActivityGroup } from "~/components/chat/common/CompactActivityGroup";
import { cn } from "~/lib/utils";
import { hierarchicalSubagents } from "./SubagentsCard.hierarchy";

export function subagentStatusLabel(agent: OrchestrationTask) {
  if ((agent.status === "pending" || agent.status === "inProgress") && !agent.activityFresh) {
    return "Last seen";
  }
  return agent.status === "inProgress" ? "Working" : agent.status;
}

export function visibleSubagents(agents: ReadonlyArray<OrchestrationTask>, expanded: boolean) {
  return expanded ? agents : agents.slice(0, 1);
}

function durationLabel(startedAt: string, endedAt: number) {
  const seconds = Math.max(0, Math.floor((endedAt - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

export function subagentTimeLabel(agent: OrchestrationTask, now = Date.now()) {
  if ((agent.status === "pending" || agent.status === "inProgress") && !agent.activityFresh) {
    return `${durationLabel(agent.updatedAt, now)} ago`;
  }
  const endedAt =
    agent.status === "completed" || agent.status === "failed" || agent.status === "stopped"
      ? Date.parse(agent.updatedAt)
      : now;
  return durationLabel(agent.createdAt, endedAt);
}

export function hasSubagentDetails(agent: OrchestrationTask) {
  return Boolean(
    agent.description || agent.lastToolName || agent.subagentType || agent.terminalReason,
  );
}

function AgentRow({
  agent,
  depth,
  parentLabel,
}: {
  agent: OrchestrationTask;
  depth: number;
  parentLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const details = hasSubagentDetails(agent) || Boolean(parentLabel);
  const detailId = `subagent-${agent.id}-details`;
  return (
    <div
      className="min-w-0 rounded-lg px-1 py-1"
      style={{ paddingLeft: `${4 + Math.min(depth, 3) * 14}px` }}
      aria-label={parentLabel ? `${agent.subject}, child of ${parentLabel}` : agent.subject}
    >
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 items-start gap-2 rounded-md text-left",
          details && "hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring",
        )}
        aria-expanded={details ? open : undefined}
        aria-controls={details ? detailId : undefined}
        disabled={!details}
        onClick={() => setOpen((value) => !value)}
      >
        <BotIcon className="mt-1 size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-xs leading-5 text-foreground/80">{agent.subject}</span>
            <span className="shrink-0 text-xs capitalize text-muted-foreground">
              {subagentStatusLabel(agent)} · {subagentTimeLabel(agent)}
            </span>
          </span>
          {agent.progressSummary || agent.lastToolName ? (
            <span className="line-clamp-2 block text-xs text-muted-foreground">
              {agent.progressSummary ?? agent.lastToolName}
            </span>
          ) : null}
        </span>
        {details ? (
          <ChevronRightIcon
            aria-hidden="true"
            className={cn("mt-0.5 size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          />
        ) : null}
      </button>
      {details && open ? (
        <div id={detailId} className="space-y-1 pl-5 text-xs text-muted-foreground">
          {agent.description ? <p className="whitespace-pre-wrap">{agent.description}</p> : null}
          {agent.lastToolName ? <p>Latest tool: {agent.lastToolName}</p> : null}
          {agent.terminalReason ? <p>Result: {agent.terminalReason}</p> : null}
          {parentLabel || agent.subagentType ? (
            <p>
              {[agent.subagentType, parentLabel ? `child of ${parentLabel}` : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SubagentsCard(props: { agents: ReadonlyArray<OrchestrationTask> }) {
  const [expanded, setExpanded] = useState(false);
  if (props.agents.length === 0) return null;
  const hierarchy = hierarchicalSubagents(props.agents);
  const visible = expanded ? hierarchy : hierarchy.slice(0, 1);
  const remaining = props.agents.length - 1;

  return (
    <section aria-label="Subagents">
      <CompactActivityGroup
        label="Subagents"
        count={props.agents.length}
        overflow={
          remaining > 0
            ? {
                expanded,
                hiddenCount: remaining,
                onToggle: () => setExpanded((value) => !value),
              }
            : undefined
        }
      >
        <div className="divide-y divide-border/50">
          {visible.map((row) => (
            <AgentRow
              key={row.agent.id}
              agent={row.agent}
              depth={row.depth}
              {...(row.parentLabel ? { parentLabel: row.parentLabel } : {})}
            />
          ))}
        </div>
      </CompactActivityGroup>
    </section>
  );
}
