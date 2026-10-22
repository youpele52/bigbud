import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { AiIcon } from "../../AiIcon";
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
  subagentStatusIsAnimating,
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
  const name = subagentDisplayName(agent);
  const onStop = canStopSubagent(agent) ? props.onStop : undefined;
  return (
    <div
      className="min-w-0 rounded-lg px-1 py-1"
      style={{ paddingLeft: `${4 + Math.min(props.depth, SUBAGENT_MAX_INDENT_DEPTH) * 14}px` }}
      aria-label={
        props.parentLabel ? `${agent.subject}, child of ${props.parentLabel}` : agent.subject
      }
      data-subagent-row={agent.id}
    >
      {/* A row-wide click target, not a button, so Stop can lead the row. */}
      <div
        className={cn(
          "flex min-w-0 items-start gap-2 rounded-md",
          details && "cursor-pointer hover:bg-muted/40",
        )}
        onClick={details ? () => setOpen((value) => !value) : undefined}
      >
        {/* Leading slot: Stop replaces the agent icon while the row can be stopped. */}
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center"
          data-subagent-leading={onStop ? "stop" : "icon"}
        >
          {onStop ? (
            <SubagentStopButton agent={agent} onStop={onStop} className="size-5 sm:size-5" />
          ) : (
            <AiIcon className="size-3 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-2">
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span data-subagent-name className="truncate text-xs leading-5 text-foreground/80">
                {name}
              </span>
              {agent.background ? (
                <span className="shrink-0 rounded bg-muted/60 px-1 text-xs leading-4 text-muted-foreground">
                  Background
                </span>
              ) : null}
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
              <span
                aria-hidden="true"
                data-subagent-status-dot
                className={cn(
                  "size-1.5 rounded-full",
                  tone.dot,
                  subagentStatusIsAnimating(agent) && "animate-breathe motion-reduce:animate-none",
                )}
              />
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
          <button
            type="button"
            className="mt-0.5 shrink-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`Details for ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
            />
          </button>
        ) : null}
      </div>
      {details && open ? (
        <SubagentRowDetails agent={agent} id={detailId} parentLabel={props.parentLabel} />
      ) : null}
    </div>
  );
}
