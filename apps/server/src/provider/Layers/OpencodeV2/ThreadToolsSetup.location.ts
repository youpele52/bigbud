import { Effect } from "effect";
import type { ServerOpencodeV2ThreadToolsSetupRequest } from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import {
  ensureOrchestrationThreadState,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { resolveThreadWorkspaceCwd } from "../../../checkpointing/Utils.ts";
import { resolveProviderSessionExecutionTargets } from "../../providerSessionExecutionTargets.ts";

/** Setup context uses the real thread worktree/project; a native config-root override never enters cwd resolution. */
export async function inferredV2SetupLocation(
  input: typeof ServerOpencodeV2ThreadToolsSetupRequest.Type,
  fallback: string,
  engine?: OrchestrationEngineShape,
) {
  // Historical read-only projections may supply their retained Location; installation never uses it.
  if (!input.refresh && input.directory) return input.directory;
  if (input.threadId) {
    if (!engine)
      throw new Error(
        "V2 current thread Location is unavailable; no arbitrary directory fallback.",
      );
    const hydrated = await Effect.runPromise(
      ensureOrchestrationThreadState(engine, input.threadId, "operational"),
    );
    const model = await Effect.runPromise(engine.getReadModel());
    const thread = hydrated && model.threads.find((thread) => thread.id === input.threadId);
    const project = thread && model.projects.find((project) => project.id === thread.projectId);
    const targets = resolveProviderSessionExecutionTargets({
      providerRuntimeExecutionTargetId: thread?.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId: thread?.workspaceExecutionTargetId,
      executionTargetId: thread?.executionTargetId,
      defaultProviderRuntimeExecutionTargetId:
        project?.providerRuntimeExecutionTargetId ?? project?.executionTargetId,
      defaultWorkspaceExecutionTargetId:
        project?.workspaceExecutionTargetId ?? project?.executionTargetId,
    });
    if (
      !thread ||
      !project ||
      thread.deletedAt ||
      project.deletedAt ||
      targets.workspaceExecutionTargetId !== "local" ||
      targets.providerRuntimeExecutionTargetId !== "local"
    )
      throw new Error(
        "V2 selected thread has no supported local native Location; no local/private fallback.",
      );
    const directory = resolveThreadWorkspaceCwd({
      thread,
      projects: model.projects,
      defaultChatCwd: fallback,
    });
    if (!directory)
      throw new Error(
        "V2 selected thread has no canonical native Location; no local/private fallback.",
      );
    return directory;
  }
  return fallback;
}
