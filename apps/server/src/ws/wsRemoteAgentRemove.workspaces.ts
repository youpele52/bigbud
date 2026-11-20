import { Effect } from "effect";
import { randomUUID } from "node:crypto";

import {
  CommandId,
  resolveExecutionTargetId,
  type ProjectId,
} from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationProject } from "@bigbud/contracts/orchestration/orchestration.project.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import type { GetProjectWorktreePathsResult } from "@bigbud/contracts/orchestration/orchestration.detail.paging.ts";

import { withSshExecutionTransport } from "../ssh/sshExecutionTarget.ts";

type ProjectReconfigureCommand = Extract<OrchestrationCommand, { type: "project.reconfigure" }>;

export interface RemoteAgentWorkspaceSwitchDependencies {
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, Error>;
  readonly getProjectWorktreePaths: (input: {
    readonly projectId: ProjectId;
  }) => Effect.Effect<GetProjectWorktreePathsResult, Error>;
  /** The same normalize-and-dispatch path the workspace dialog's Save uses. */
  readonly dispatch: (command: ProjectReconfigureCommand) => Effect.Effect<unknown, Error>;
}

function workspaceTarget(project: OrchestrationProject): string {
  return resolveExecutionTargetId(project.workspaceExecutionTargetId ?? project.executionTargetId);
}

/** Saved, non-deleted workspaces whose files live on this agent target. */
export function remoteAgentWorkspaces(
  readModel: OrchestrationReadModel,
  agentTarget: string,
): ReadonlyArray<OrchestrationProject> {
  const target = resolveExecutionTargetId(agentTarget);
  return readModel.projects.filter(
    (project) =>
      project.deletedAt === null &&
      project.deletingAt === null &&
      workspaceTarget(project) === target,
  );
}

/**
 * Builds the Edit dialog's `project.reconfigure` for a transport-only change. Host, user, port,
 * key and folder are unchanged, so the worktree paths are the same files over Direct SSH.
 */
export function buildDirectSshReconfigure(input: {
  readonly project: OrchestrationProject;
  readonly agentTarget: string;
  readonly directTarget: string;
  readonly worktreePaths: ReadonlyArray<string>;
}): ProjectReconfigureCommand {
  const { project } = input;
  const providerTarget = resolveExecutionTargetId(
    project.providerRuntimeExecutionTargetId ?? project.executionTargetId,
  );
  const directTarget =
    input.directTarget as ProjectReconfigureCommand["workspaceExecutionTargetId"];
  return {
    type: "project.reconfigure",
    commandId: CommandId.makeUnsafe(`server:remote-agent-remove:${randomUUID()}`),
    projectId: project.id,
    title: project.title,
    providerRuntimeExecutionTargetId:
      providerTarget === resolveExecutionTargetId(input.agentTarget)
        ? directTarget
        : (providerTarget as ProjectReconfigureCommand["providerRuntimeExecutionTargetId"]),
    workspaceExecutionTargetId: directTarget,
    executionTargetId: directTarget,
    workspaceRoot: project.workspaceRoot,
    expectedUpdatedAt: project.updatedAt,
    verifiedWorktreePaths: [
      ...new Set(input.worktreePaths.map((path) => path.trim()).filter((path) => path.length > 0)),
    ],
  };
}

/**
 * Moves each workspace on the removed agent's host to Direct SSH. One workspace failing (busy
 * threads, a concurrent edit) leaves it on the agent and never stops the others.
 */
export const switchRemoteAgentWorkspacesToDirectSsh = Effect.fn(
  "switchRemoteAgentWorkspacesToDirectSsh",
)(function* (agentTarget: string, dependencies: RemoteAgentWorkspaceSwitchDependencies) {
  const directTarget = withSshExecutionTransport(agentTarget, "direct-ssh");
  if (!directTarget) return [] as ReadonlyArray<ProjectId>;
  const readModel = yield* dependencies.getReadModel();
  const switched: ProjectId[] = [];
  for (const project of remoteAgentWorkspaces(readModel, agentTarget)) {
    const done = yield* Effect.gen(function* () {
      const paths = yield* dependencies.getProjectWorktreePaths({ projectId: project.id });
      if (paths.truncated) return false;
      yield* dependencies.dispatch(
        buildDirectSshReconfigure({
          project,
          agentTarget,
          directTarget,
          worktreePaths: paths.worktreePaths,
        }),
      );
      return true;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("remote agent removal could not switch a workspace to Direct SSH", {
          projectId: project.id,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
    if (done) switched.push(project.id);
  }
  return switched as ReadonlyArray<ProjectId>;
});
