import { useState } from "react";
import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.tasks.ts";

import { CompactActivityGroup } from "~/components/chat/common/CompactActivityGroup";
import { SubagentRow } from "./SubagentRow";
import type { SubagentStopHandler } from "./SubagentRow.stop";
import { hierarchicalSubagents } from "./SubagentsCard.hierarchy";
import { visibleSubagents } from "./subagentPresentation.logic";

export function SubagentsCard(props: {
  agents: ReadonlyArray<OrchestrationTask>;
  /** Shared chat clock; live elapsed time advances with it. Defaults to render time. */
  nowIso?: string | undefined;
  /** Per-subagent Stop; set only when the active provider supports it. */
  onStopSubagent?: SubagentStopHandler | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  if (props.agents.length === 0) return null;
  const hierarchy = hierarchicalSubagents(props.agents);
  const visible = visibleSubagents(hierarchy, expanded);
  const remaining = props.agents.length - 1;
  const parsedNow = props.nowIso ? Date.parse(props.nowIso) : Number.NaN;
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();

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
            <SubagentRow
              key={row.agent.id}
              agent={row.agent}
              depth={row.depth}
              parentLabel={row.parentLabel}
              nowMs={nowMs}
              onStop={props.onStopSubagent}
            />
          ))}
        </div>
      </CompactActivityGroup>
    </section>
  );
}
