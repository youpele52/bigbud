import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import { cn } from "~/lib/utils";
import { CHAT_COLUMN_CLASS_NAME } from "../common/chatColumn";
import { isFreshActiveProviderAgent } from "./agentActivity.presentation";
import { SubagentsCard } from "./SubagentsCard";
import type { SubagentStopHandler } from "./SubagentRow.stop";

export function ChatAgentActivityFeed(props: {
  agents: ReadonlyArray<OrchestrationTask>;
  nowIso?: string | undefined;
  onStopSubagent?: SubagentStopHandler | undefined;
}) {
  const active = props.agents.filter(isFreshActiveProviderAgent);
  if (active.length === 0) return null;
  return (
    <div
      className={cn(CHAT_COLUMN_CLASS_NAME, "mt-2 mb-8")}
      data-agent-feed-placement="timeline-end"
    >
      <SubagentsCard agents={active} nowIso={props.nowIso} onStopSubagent={props.onStopSubagent} />
    </div>
  );
}
