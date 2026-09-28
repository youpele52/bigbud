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
