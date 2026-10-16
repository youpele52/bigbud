import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.tasks.ts";

import { cn } from "~/lib/utils";
import { SUBAGENT_STATUS_TONE_CLASSES, subagentMetricsLabel } from "./subagentPresentation.logic";

const STEP_TONE = {
  running: SUBAGENT_STATUS_TONE_CLASSES.working,
  completed: SUBAGENT_STATUS_TONE_CLASSES.done,
  failed: SUBAGENT_STATUS_TONE_CLASSES.failed,
} as const;

const STEP_LABEL = { running: "running", completed: "done", failed: "failed" } as const;

/** Expanded subagent details: prompt, steps, metrics, result or failure, and lineage. */
export function SubagentRowDetails(props: {
  agent: OrchestrationTask;
  id: string;
  parentLabel?: string | undefined;
}) {
  const { agent } = props;
  const metrics = subagentMetricsLabel(agent.metrics);
  const showSubject = Boolean(agent.subagentType && agent.subagentType !== agent.subject);
  const lineage = [agent.subagentType, props.parentLabel ? `child of ${props.parentLabel}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div id={props.id} className="min-w-0 space-y-1 pl-5 text-xs text-muted-foreground">
      {showSubject ? <p className="break-words text-foreground/80">{agent.subject}</p> : null}
      {agent.description ? (
        <p className="whitespace-pre-wrap break-words">{agent.description}</p>
      ) : null}
      {agent.prompt ? (
        <p className="line-clamp-6 whitespace-pre-wrap break-words">
          <span className="text-foreground/70">Prompt: </span>
          {agent.prompt}
        </p>
      ) : null}
      {agent.recentSteps && agent.recentSteps.length > 0 ? (
        <ul aria-label="Recent steps" className="space-y-0.5">
          {agent.recentSteps.map((step, index) => (
            <li
              key={step.id ?? `${step.toolName}-${index}`}
              className="flex min-w-0 items-center gap-1.5"
            >
              <span
                aria-hidden="true"
                className={cn("size-1.5 shrink-0 rounded-full", STEP_TONE[step.status].dot)}
              />
              <span className="shrink-0 text-foreground/80">{step.toolName}</span>
              {step.label ? <span className="min-w-0 truncate">{step.label}</span> : null}
              <span className={cn("ml-auto shrink-0", STEP_TONE[step.status].text)}>
                {STEP_LABEL[step.status]}
              </span>
            </li>
          ))}
        </ul>
      ) : agent.lastToolName ? (
        <p>Latest tool: {agent.lastToolName}</p>
      ) : null}
      {metrics ? <p>{metrics}</p> : null}
      {agent.resultSummary ? (
        <p className="whitespace-pre-wrap break-words">Result: {agent.resultSummary}</p>
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
      {lineage ? <p className="break-words">{lineage}</p> : null}
    </div>
  );
}
