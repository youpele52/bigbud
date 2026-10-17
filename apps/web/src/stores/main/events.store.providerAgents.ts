import type { OrchestrationSession, OrchestrationTask } from "@bigbud/contracts";

import type { ThreadSession } from "../../models/types";

export function demoteProviderAgentsForSession(
  agents: ReadonlyArray<OrchestrationTask> | undefined,
  previous: ThreadSession | null,
  incoming: OrchestrationSession,
): OrchestrationTask[] | undefined {
  if (!agents) return undefined;
  const epochChanged =
    previous?.sessionEpoch !== undefined &&
    incoming.sessionEpoch !== undefined &&
    previous.sessionEpoch !== incoming.sessionEpoch;
  const lostContinuity =
    epochChanged ||
    incoming.status === "interrupted" ||
    incoming.status === "stopped" ||
    incoming.status === "error";
  if (!lostContinuity) return [...agents];
  return agents.map((agent) => (agent.activityFresh ? { ...agent, activityFresh: false } : agent));
}

/** Per-thread bound on provider agents kept in client memory. */
export const MAX_THREAD_PROVIDER_AGENTS = 100;

const isActiveAgent = (agent: OrchestrationTask) =>
  agent.status === "pending" || agent.status === "inProgress";

/** Keeps every active agent and drops the oldest terminal ones above the bound. */
export function capProviderAgents(agents: ReadonlyArray<OrchestrationTask>): OrchestrationTask[] {
  let excess = agents.length - MAX_THREAD_PROVIDER_AGENTS;
  if (excess <= 0) return [...agents];
  const dropped = new Set<OrchestrationTask>();
  const oldestTerminalFirst = agents
    .filter((agent) => !isActiveAgent(agent))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const agent of oldestTerminalFirst) {
    if (excess <= 0) break;
    dropped.add(agent);
    excess -= 1;
  }
  return agents.filter((agent) => !dropped.has(agent));
}

export function upsertProviderAgent(
  agents: ReadonlyArray<OrchestrationTask> | undefined,
  task: OrchestrationTask,
): OrchestrationTask[] {
  return capProviderAgents([...(agents ?? []).filter((agent) => agent.id !== task.id), task]);
}

export function removeProviderAgent(
  agents: ReadonlyArray<OrchestrationTask> | undefined,
  taskId: string,
): OrchestrationTask[] {
  return (agents ?? []).filter((agent) => agent.id !== taskId);
}
