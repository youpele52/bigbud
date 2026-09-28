import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import { isFreshActiveProviderAgent } from "../../agents/agentActivity.presentation";

export function resolveAgentActivityPresentation(input: {
  readonly mainActive: boolean;
  readonly mainVerb: string;
  readonly agents: ReadonlyArray<OrchestrationTask>;
}) {
  const freshAgents = input.agents.filter(isFreshActiveProviderAgent);
  if (input.mainActive) {
    return { visible: true, tone: "main" as const, verb: input.mainVerb, freshAgents };
  }
  if (freshAgents.length > 0) {
    return {
      visible: true,
      tone: "subagent" as const,
      verb: `${freshAgents.length} subagent${freshAgents.length === 1 ? "" : "s"} working`,
      freshAgents,
    };
  }
  return { visible: false, tone: "main" as const, verb: input.mainVerb, freshAgents };
}
