import type { GitRunStackedActionInput } from "@bigbud/contracts";
import { Effect } from "effect";
import type { GitManagerShape, GitRunStackedActionOptions } from "../git/Services/GitManager.ts";
import { lastSuccessfulThreadModel } from "../git/Layers/InternalTextGeneration.success.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { resolveWorkspaceExecutionTargetId } from "../workspace-target/workspaceTarget.ts";
import {
  ensureOrchestrationThreadState,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";

/** The server, not the client, binds Git generation to verified success in the associated workspace. */
export function runThreadAwareGitAction(
  context: {
    readonly gitManager: GitManagerShape;
    readonly orchestrationEngine: OrchestrationEngineShape;
  },
  input: GitRunStackedActionInput,
  options: GitRunStackedActionOptions,
) {
  return Effect.gen(function* () {
    const thread = input.threadId
      ? yield* ensureOrchestrationThreadState(
          context.orchestrationEngine,
          input.threadId,
          "history",
        )
      : undefined;
    const model = thread ? yield* context.orchestrationEngine.getReadModel() : null;
    const sameWorkspace =
      thread &&
      model &&
      resolveWorkspaceExecutionTargetId(thread) === resolveWorkspaceExecutionTargetId(input) &&
      resolveThreadWorkspaceCwd({ thread, projects: model.projects }) === input.cwd;
    const successfulModelSelection = sameWorkspace ? lastSuccessfulThreadModel(thread) : null;
    return yield* context.gitManager.runStackedAction(input, {
      ...options,
      successfulModelSelection,
    });
  });
}
