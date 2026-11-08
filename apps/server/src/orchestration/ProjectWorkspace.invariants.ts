import {
  isLocalExecutionTargetId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProjectId,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { isThreadTurnDispatchBlocked } from "./ThreadDispatchSafety.logic.ts";

/** Applies inside the serialized command processor, not just in the editor UI. */
export function requireProjectWorkspaceChangeSafe(input: {
  command: OrchestrationCommand;
  readModel: OrchestrationReadModel;
  projectId: ProjectId;
  workspaceRoot: string | null;
}) {
  const project = input.readModel.projects.find((entry) => entry.id === input.projectId);
  const changed =
    project?.workspaceRoot !== input.workspaceRoot ||
    (input.command.type === "project.reconfigure" &&
      (input.command.workspaceExecutionTargetId !==
        (project?.workspaceExecutionTargetId ?? project?.executionTargetId) ||
        input.command.providerRuntimeExecutionTargetId !==
          (project?.providerRuntimeExecutionTargetId ?? project?.executionTargetId)));
  if (!changed) return Effect.void;
  const threads = input.readModel.threads.filter((thread) => thread.projectId === input.projectId);
  const busy = threads.find(
    (thread) =>
      isThreadTurnDispatchBlocked(thread) ||
      thread.tasks?.some((task) => task.status === "pending" || task.status === "inProgress"),
  );
  const localFolderChange =
    isLocalExecutionTargetId(project?.workspaceExecutionTargetId ?? project?.executionTargetId) &&
    (input.command.type !== "project.reconfigure" ||
      isLocalExecutionTargetId(input.command.workspaceExecutionTargetId));
  const worktree = localFolderChange
    ? threads.find((thread) => thread.worktreePath != null)
    : undefined;
  const detail = busy
    ? `Thread '${busy.id}' has an active turn or session, pending execution, or unfinished tasks. Stop or finish this work before changing its project folder.`
    : worktree
      ? `Thread '${worktree.id}' retains worktree '${worktree.worktreePath}'. Remove or detach that worktree before changing the project folder; historical worktrees cannot be reassigned safely.`
      : input.command.type === "project.meta.update"
        ? "Use project.reconfigure to change a project folder safely."
        : null;
  return detail
    ? Effect.fail(
        new OrchestrationCommandInvariantError({ commandType: input.command.type, detail }),
      )
    : Effect.void;
}
