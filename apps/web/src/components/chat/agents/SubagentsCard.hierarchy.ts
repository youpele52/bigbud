import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

export interface HierarchicalSubagent {
  agent: OrchestrationTask;
  depth: number;
  parentLabel?: string;
}

export function hierarchicalSubagents(
  agents: ReadonlyArray<OrchestrationTask>,
): HierarchicalSubagent[] {
  const byIdentity = new Map<string, OrchestrationTask>();
  for (const agent of agents) {
    for (const identity of [agent.id, agent.nativeId, agent.agentId]) {
      if (identity) byIdentity.set(identity, agent);
    }
  }
  const children = new Map<OrchestrationTask, OrchestrationTask[]>();
  const roots: OrchestrationTask[] = [];
  for (const agent of agents) {
    const parent = agent.parentAgentId ? byIdentity.get(agent.parentAgentId) : undefined;
    if (!parent || parent === agent) roots.push(agent);
    else children.set(parent, [...(children.get(parent) ?? []), agent]);
  }
  const result: HierarchicalSubagent[] = [];
  const visited = new Set<OrchestrationTask>();
  function visit(agent: OrchestrationTask, depth: number, parentLabel?: string) {
    if (visited.has(agent)) return;
    visited.add(agent);
    result.push({ agent, depth, ...(parentLabel ? { parentLabel } : {}) });
    for (const child of children.get(agent) ?? []) visit(child, depth + 1, agent.subject);
  }
  for (const root of roots) visit(root, 0);
  for (const agent of agents) visit(agent, 0);
  return result;
}
