import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";
import type {
  ExecutionTargetId,
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { hasActiveThreadTurnOrSession } from "./ThreadDispatchSafety.logic.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project && project.deletedAt === null) {
    return Effect.succeed(project);
  }
  if (project) {
    return Effect.fail(
      invariantError(
        input.command.type,
        `Project '${input.projectId}' has already been deleted and cannot handle command '${input.command.type}'.`,
      ),
    );
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectDeleting(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  return requireProject(input).pipe(
    Effect.flatMap((project) =>
      project.deletingAt !== null && project.deletingAt !== undefined
        ? Effect.succeed(project)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Project '${input.projectId}' is not pending deletion for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireProjectNotDeleting(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  return requireProject(input).pipe(
    Effect.flatMap((project) =>
      project.deletingAt === null || project.deletingAt === undefined
        ? Effect.succeed(project)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Project '${input.projectId}' is already being deleted and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
  readonly workspaceRoot?: string | null;
  readonly workspaceExecutionTargetId?: ExecutionTargetId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const existingById = findProjectById(input.readModel, input.projectId);
  if (existingById && existingById.deletedAt === null) {
    return Effect.fail(
      invariantError(
        input.command.type,
        `Project '${input.projectId}' already exists and cannot be created twice.`,
      ),
    );
  }
  if (input.workspaceRoot === null || input.workspaceRoot === undefined) {
    return Effect.void;
  }
  const existing = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      project.workspaceRoot === input.workspaceRoot &&
      (project.workspaceExecutionTargetId ??
        project.executionTargetId ??
        LOCAL_EXECUTION_TARGET_ID) === input.workspaceExecutionTargetId,
  );
  return existing
    ? Effect.fail(
        invariantError(
          input.command.type,
          `A project already exists for workspace '${input.workspaceRoot}'.`,
        ),
      )
    : Effect.void;
}

export function requireProjectWorkspaceAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string | null;
  readonly workspaceExecutionTargetId: ExecutionTargetId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.workspaceRoot === null) {
    return Effect.void;
  }
  const existing = input.readModel.projects.find(
    (project) =>
      project.id !== input.projectId &&
      project.deletedAt === null &&
      project.workspaceRoot === input.workspaceRoot &&
      (project.workspaceExecutionTargetId ??
        project.executionTargetId ??
        LOCAL_EXECUTION_TARGET_ID) === input.workspaceExecutionTargetId,
  );
  return existing
    ? Effect.fail(
        invariantError(
          input.command.type,
          `A project already exists for workspace '${input.workspaceRoot}'.`,
        ),
      )
    : Effect.void;
}

export function requireProjectThreadsIdle(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const activeThread = listThreadsByProjectId(input.readModel, input.projectId).find(
    (thread) => thread.deletedAt === null && hasActiveThreadTurnOrSession(thread),
  );
  return activeThread
    ? Effect.fail(
        invariantError(
          input.command.type,
          `Project '${input.projectId}' cannot be reconfigured while thread '${activeThread.id}' has an active turn or session.`,
        ),
      )
    : Effect.void;
}

export function requireProjectRevision(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
  readonly expectedUpdatedAt: string;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  return project?.deletedAt === null && project.updatedAt === input.expectedUpdatedAt
    ? Effect.void
    : Effect.fail(
        invariantError(
          input.command.type,
          `Project '${input.projectId}' changed after editing started. Reopen the SSH configuration and try again.`,
        ),
      );
}

export function requireProjectWorktreesVerified(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
  readonly verifiedWorktreePaths: ReadonlyArray<string>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const verifiedPaths = new Set(input.verifiedWorktreePaths);
  const unverifiedPath = listThreadsByProjectId(input.readModel, input.projectId).find(
    (thread) =>
      thread.deletedAt === null &&
      thread.worktreePath !== null &&
      !verifiedPaths.has(thread.worktreePath),
  )?.worktreePath;
  return unverifiedPath === undefined
    ? Effect.void
    : Effect.fail(
        invariantError(
          input.command.type,
          `Thread worktree '${unverifiedPath}' was not verified on the new SSH target.`,
        ),
      );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread && thread.deletedAt === null) {
    return Effect.succeed(thread);
  }
  if (thread) {
    return Effect.fail(
      invariantError(
        input.command.type,
        `Thread '${input.threadId}' has already been deleted and cannot handle command '${input.command.type}'.`,
      ),
    );
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadDeleting(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.deletingAt !== null && thread.deletingAt !== undefined
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not pending deletion for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotDeleting(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.deletingAt === null || thread.deletingAt === undefined
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already being deleted and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const existing = findThreadById(input.readModel, input.threadId);
  if (!existing || existing.deletedAt !== null) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
