import { compareTaskFreshness } from "@bigbud/shared/providerRuntime";
import type { Thread } from "../models/types";

type Agent = NonNullable<Thread["providerAgents"]>[number];

/** Summary previews must not hide newly discovered work or replace newer live task proof. */
export function mergeNotificationTasks(
  existing: ReadonlyArray<Agent>,
  incoming: ReadonlyArray<Agent>,
): Agent[] {
  const tasks = new Map(existing.map((task) => [task.id, task]));
  for (const candidate of incoming) {
    const previous = tasks.get(candidate.id);
    if (
      !previous ||
      compareTaskFreshness(candidate.freshness, previous.freshness) > 0 ||
      // Epoch identities and wall clocks do not order conflicting proof. Fail closed on ties.
      (compareTaskFreshness(candidate.freshness, previous.freshness) === 0 &&
        previous.status === "completed" &&
        candidate.status !== "completed")
    ) {
      tasks.set(candidate.id, candidate);
    }
  }
  return [...tasks.values()];
}
