import { ProjectId } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  ensureOrchestrationProjectState,
  ensureOrchestrationProjectThreads,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

export function makeProviderCommandProjectResolvers(orchestrationEngine: OrchestrationEngineShape) {
  const resolveProject = Effect.fn("resolveProject")(function* (projectId: ProjectId) {
    return yield* ensureOrchestrationProjectState(orchestrationEngine, projectId);
  });

  /** Every live thread of the project, hydrated: the deletion cascade must see evicted ones. */
  const resolveThreadsByProject = Effect.fn("resolveThreadsByProject")(function* (
    projectId: ProjectId,
  ) {
    return yield* ensureOrchestrationProjectThreads(orchestrationEngine, projectId);
  });

  return { resolveProject, resolveThreadsByProject };
}
