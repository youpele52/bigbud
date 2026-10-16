import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import {
  hasFreshActiveProviderAgent,
  isFreshActiveProviderAgent,
} from "../../agents/agentActivity.presentation";

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

/**
 * The elapsed-time clock ticks while the main turn works or any fresh subagent is active,
 * so a background subagent keeps counting after its parent turn ends.
 */
export function shouldTickElapsedClock(input: {
  readonly mainWorking: boolean;
  readonly agents: ReadonlyArray<OrchestrationTask> | undefined;
}): boolean {
  return input.mainWorking || hasFreshActiveProviderAgent(input.agents);
}
