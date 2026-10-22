import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.tasks.ts";

import { cn } from "~/lib/utils";
import { formatToolDisplayName } from "~/lib/toolPresentation";
import { Button, textButtonTypography } from "../../ui/button";
import {
  SUBAGENT_STATUS_TONE_CLASSES,
  subagentMetricsLabel,
  subagentRecentStepsLabel,
  subagentStepLabel,
} from "./subagentPresentation.logic";

const STEP_TONE = {
  running: SUBAGENT_STATUS_TONE_CLASSES.working,
  completed: SUBAGENT_STATUS_TONE_CLASSES.done,
  failed: SUBAGENT_STATUS_TONE_CLASSES.failed,
} as const;

const STEP_LABEL = { running: "running", completed: "done", failed: "failed" } as const;

/** Expanded subagent details, grouped as task, meta, outcome, prompt, and recent steps. */
export function SubagentRowDetails(props: {
  agent: OrchestrationTask;
  id: string;
  parentLabel?: string | undefined;
}) {
  const { agent } = props;
  const metrics = subagentMetricsLabel(agent.metrics);
  const showSubject = Boolean(agent.subagentType && agent.subagentType !== agent.subject);
  const hasMeta = Boolean(agent.subagentType || props.parentLabel || metrics);
  return (
    <div
      id={props.id}
      className="mt-1 ml-7 min-w-0 divide-y divide-border/40 overflow-hidden rounded-md border border-border/40 bg-background/30 text-xs text-muted-foreground"
    >
      {showSubject || agent.description ? (
        <DetailSection label="Task">
          {showSubject ? <p className="break-words text-foreground/80">{agent.subject}</p> : null}
          {agent.description ? (
            <p className="whitespace-pre-wrap break-words">{agent.description}</p>
          ) : null}
        </DetailSection>
      ) : null}
      {hasMeta ? (
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 px-2.5 py-1.5">
          {agent.subagentType ? (
            <span className="min-w-0 break-words">
              Type <span className="text-foreground/80">{agent.subagentType}</span>
            </span>
          ) : null}
          {props.parentLabel ? (
            <span className="min-w-0 break-words">
              Parent <span className="text-foreground/80">{props.parentLabel}</span>
            </span>
          ) : null}
          {metrics ? <span>{metrics}</span> : null}
        </div>
      ) : null}
      {agent.resultSummary || agent.terminalReason ? (
        <DetailSection label="Outcome">
          {agent.resultSummary ? (
            <p className="whitespace-pre-wrap break-words text-foreground/80">
              Result: {agent.resultSummary}
            </p>
          ) : null}
          {agent.terminalReason ? (
            <p
              className={cn(
                "break-words",
                agent.status === "failed" && SUBAGENT_STATUS_TONE_CLASSES.failed.text,
              )}
            >
              {agent.status === "failed" ? "Failure" : "Reason"}: {agent.terminalReason}
            </p>
          ) : null}
        </DetailSection>
      ) : null}
      {agent.prompt ? <PromptSection prompt={agent.prompt} /> : null}
      {agent.recentSteps && agent.recentSteps.length > 0 ? (
        <DetailSection label={subagentRecentStepsLabel(agent)}>
          <ul
            aria-label="Recent steps"
            className="grid min-w-0 grid-cols-[0.375rem_fit-content(8rem)_minmax(0,1fr)_auto] gap-x-2 gap-y-0.5"
          >
            {agent.recentSteps.map((step, index) => {
              const label = subagentStepLabel(step);
              return (
                <li
                  key={step.id ?? `${step.toolName}-${index}`}
                  className="col-span-full grid min-w-0 grid-cols-subgrid items-center"
                >
                  <span
                    aria-hidden="true"
                    className={cn("size-1.5 rounded-full", STEP_TONE[step.status].dot)}
                  />
                  <span className="truncate text-foreground/80" title={step.toolName}>
                    {formatToolDisplayName(step.toolName)}
                  </span>
                  <span className="truncate font-mono text-[11px]" title={label}>
                    {label}
                  </span>
                  <span className={STEP_TONE[step.status].text}>{STEP_LABEL[step.status]}</span>
                </li>
              );
            })}
          </ul>
        </DetailSection>
      ) : agent.lastToolName ? (
        <DetailSection label="Latest tool">
          <p className="text-foreground/80" title={agent.lastToolName}>
            {formatToolDisplayName(agent.lastToolName)}
          </p>
        </DetailSection>
      ) : null}
    </div>
  );
}

function DetailSection(props: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={props.label} className="min-w-0 space-y-0.5 px-2.5 py-1.5">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <p className={textButtonTypography}>{props.label}</p>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

/** Two-line prompt preview; the toggle appears only when the clamp actually hides text. */
function PromptSection(props: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.prompt, expanded]);
  return (
    <DetailSection
      label="Prompt"
      action={
        clamped || expanded ? (
          <Button
            size="xs"
            variant="text"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Hide full prompt" : "Show full prompt"}
          </Button>
        ) : null
      }
    >
      <p
        ref={textRef}
        className={cn("whitespace-pre-wrap break-words", !expanded && "line-clamp-2")}
      >
        {props.prompt}
      </p>
    </DetailSection>
  );
}
