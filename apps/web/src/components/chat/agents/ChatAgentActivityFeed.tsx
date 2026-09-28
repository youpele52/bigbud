import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import { isFreshActiveProviderAgent } from "./agentActivity.presentation";
import { SubagentsCard } from "./SubagentsCard";

export function ChatAgentActivityFeed(props: { agents: ReadonlyArray<OrchestrationTask> }) {
  const active = props.agents.filter(isFreshActiveProviderAgent);
  if (active.length === 0) return null;
  return (
    <div className="mt-2 mb-8" data-agent-feed-placement="timeline-end">
      <SubagentsCard agents={active} />
    </div>
  );
}
