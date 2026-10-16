import { useState } from "react";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.tasks.ts";

import { cn } from "~/lib/utils";
import { SubagentRowDetails } from "./SubagentRow.details";
import { SubagentStopButton, canStopSubagent, type SubagentStopHandler } from "./SubagentRow.stop";
import {
  SUBAGENT_MAX_INDENT_DEPTH,
  SUBAGENT_STATUS_TONE_CLASSES,
  hasSubagentDetails,
  subagentActivityLine,
  subagentDisplayName,
  subagentModelLabel,
  subagentStatusLabel,
  subagentStatusTone,
  subagentTimeLabel,
} from "./subagentPresentation.logic";

export function SubagentRow(props: {
  agent: OrchestrationTask;
  depth: number;
  parentLabel?: string | undefined;
  nowMs: number;
  onStop?: SubagentStopHandler | undefined;
}) {
  const { agent } = props;
  const [open, setOpen] = useState(false);
  const details = hasSubagentDetails(agent) || Boolean(props.parentLabel);
  const detailId = `subagent-${agent.id}-details`;
  const tone = SUBAGENT_STATUS_TONE_CLASSES[subagentStatusTone(agent)];
  const model = subagentModelLabel(agent);
  const activity = subagentActivityLine(agent);
  return (
    <div
      className="min-w-0 rounded-lg px-1 py-1"
      style={{ paddingLeft: `${4 + Math.min(props.depth, SUBAGENT_MAX_INDENT_DEPTH) * 14}px` }}
      aria-label={
        props.parentLabel ? `${agent.subject}, child of ${props.parentLabel}` : agent.subject
      }
      data-subagent-row={agent.id}
    >
      <div className="flex min-w-0 items-start gap-1">
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
            <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-2">
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate text-xs leading-5 text-foreground/80">
                  {subagentDisplayName(agent)}
                </span>
                {model ? (
                  <span
                    className="max-w-[10rem] shrink truncate rounded bg-muted/60 px-1 text-xs leading-4 text-muted-foreground"
                    title={model}
                  >
                    {model}
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone.dot)} />
                <span className={tone.text} data-subagent-status>
                  {subagentStatusLabel(agent)}
                </span>
                <span>· {subagentTimeLabel(agent, props.nowMs)}</span>
              </span>
            </span>
            {activity ? (
              <span className="line-clamp-2 block break-words text-xs text-muted-foreground">
                {activity}
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
        {props.onStop && canStopSubagent(agent) ? (
          <SubagentStopButton agent={agent} onStop={props.onStop} />
        ) : null}
      </div>
      {details && open ? (
        <SubagentRowDetails agent={agent} id={detailId} parentLabel={props.parentLabel} />
      ) : null}
    </div>
  );
}
