import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

export const CHILD_PROVIDER_ICON_CLASS = "text-violet-500";

export function isFreshActiveProviderAgent(agent: OrchestrationTask): boolean {
  return agent.status === "inProgress" && agent.activityFresh === true;
}

export function hasFreshActiveProviderAgent(
  agents: ReadonlyArray<OrchestrationTask> | undefined,
): boolean {
  return agents?.some(isFreshActiveProviderAgent) === true;
}
