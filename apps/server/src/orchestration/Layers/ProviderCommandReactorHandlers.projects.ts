import { ProjectId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

export function makeProviderCommandProjectResolvers(orchestrationEngine: OrchestrationEngineShape) {
  const resolveProject = Effect.fn("resolveProject")(function* (projectId: ProjectId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.projects.find((entry) => entry.id === projectId);
  });

  const resolveThreadsByProject = Effect.fn("resolveThreadsByProject")(function* (
    projectId: ProjectId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.filter((entry) => entry.projectId === projectId);
  });

  return { resolveProject, resolveThreadsByProject };
}
