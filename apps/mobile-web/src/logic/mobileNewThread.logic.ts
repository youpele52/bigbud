import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type OrchestrationProject,
  PROVIDER_KINDS,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadTurnStartBootstrap,
} from "@bigbud/contracts";
import { DEFAULT_THREAD_TITLE, fallbackThreadTitleFromPrompt } from "@bigbud/shared/String";

import { buildExplicitExecutionTargets } from "~/lib/providerExecutionTargets";

export function resolveMobileModelSelection(project: OrchestrationProject): ModelSelection {
  if (project.defaultModelSelection) {
    return project.defaultModelSelection;
  }
  const provider = PROVIDER_KINDS[0];
  return { provider, model: DEFAULT_MODEL_BY_PROVIDER[provider] };
}

export function buildMobileCreateThreadBootstrap(input: {
  readonly project: OrchestrationProject;
  readonly promptText: string;
  readonly createdAt: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly modelSelection?: ModelSelection;
}): ThreadTurnStartBootstrap {
  const modelSelection = input.modelSelection ?? resolveMobileModelSelection(input.project);
  const executionTargets = buildExplicitExecutionTargets({
    providerRuntimeExecutionTargetId: input.project.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: input.project.workspaceExecutionTargetId,
  });
  const seededTitle = fallbackThreadTitleFromPrompt(input.promptText);
  const title = seededTitle === DEFAULT_THREAD_TITLE ? DEFAULT_THREAD_TITLE : seededTitle;

  return {
    createThread: {
      projectId: input.project.id,
      title,
      ...executionTargets,
      modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: input.branch,
      worktreePath: input.worktreePath,
      createdAt: input.createdAt,
    },
  };
}
