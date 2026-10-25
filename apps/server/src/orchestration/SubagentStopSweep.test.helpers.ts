import { type OrchestrationTask, RuntimeTaskId } from "@bigbud/contracts";

/** A running provider subagent row created before the Stop request used across sweep tests. */
export const subagentTask = (
  id: string,
  overrides: Partial<OrchestrationTask> = {},
): OrchestrationTask => ({
  id: RuntimeTaskId.makeUnsafe(id),
  kind: "providerSubagent",
  nativeId: `native-${id}`,
  activityFresh: true,
  status: "inProgress",
  subject: `Subagent ${id}`,
  source: "lifecycle",
  freshness: { sessionEpoch: "1", sourcePriority: 3, observedOrdinal: 7 },
  createdAt: "2026-10-21T09:59:00.000Z",
  updatedAt: "2026-10-21T09:59:30.000Z",
  ...overrides,
});
