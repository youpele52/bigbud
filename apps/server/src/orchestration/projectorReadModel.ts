import type { OrchestrationReadModel } from "@bigbud/contracts";

export const createEmptyReadModel = (nowIso: string): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: nowIso,
});
