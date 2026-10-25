import { useState } from "react";
import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.tasks.ts";

import { ActivityAccordion } from "~/components/chat/common/ActivityAccordion";
import type { ActivityAccordionControl } from "~/components/chat/common/ActivityAccordion.state";
import { ActivityOverflowToggle } from "~/components/chat/common/ActivityOverflowToggle";
import { CompactActivityGroup } from "~/components/chat/common/CompactActivityGroup";
import { SubagentRow } from "./SubagentRow";
import type { SubagentStopHandler } from "./SubagentRow.stop";
import { hierarchicalSubagents } from "./SubagentsCard.hierarchy";
import { visibleSubagents } from "./subagentPresentation.logic";

/**
 * `card` is the live feed with Stop buttons; `accordion` is the finished timeline history,
 * collapsed by default and persisted through `accordion`.
 */
export type SubagentsCardPresentation = "card" | "accordion";

export function SubagentsCard(props: {
  agents: ReadonlyArray<OrchestrationTask>;
  /** Shared chat clock; live elapsed time advances with it. Defaults to render time. */
  nowIso?: string | undefined;
  /** Per-subagent Stop; set only when the active provider supports it. */
  onStopSubagent?: SubagentStopHandler | undefined;
  presentation?: SubagentsCardPresentation | undefined;
  /** Persisted open state for the `accordion` presentation; uncontrolled when omitted. */
  accordion?: ActivityAccordionControl | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  if (props.agents.length === 0) return null;
  const hierarchy = hierarchicalSubagents(props.agents);
  const visible = visibleSubagents(hierarchy, expanded);
  const remaining = props.agents.length - 1;
  const parsedNow = props.nowIso ? Date.parse(props.nowIso) : Number.NaN;
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const overflow =
    remaining > 0
      ? { expanded, hiddenCount: remaining, onToggle: () => setExpanded((value) => !value) }
      : undefined;
  const rows = (
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
  );

  return (
    <section aria-label="Subagents">
      {props.presentation === "accordion" ? (
        <ActivityAccordion
          title={`Subagents (${props.agents.length})`}
          actions={overflow ? <ActivityOverflowToggle {...overflow} /> : undefined}
          {...props.accordion}
        >
          {rows}
        </ActivityAccordion>
      ) : (
        <CompactActivityGroup label="Subagents" count={props.agents.length} overflow={overflow}>
          {rows}
        </CompactActivityGroup>
      )}
    </section>
  );
}
