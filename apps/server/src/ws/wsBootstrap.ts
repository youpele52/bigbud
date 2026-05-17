/**
 * Bootstrap turn-start logic for the WebSocket RPC layer.
 *
 * Extracted from ws.ts to keep that file under 500 lines.
 * `dispatchBootstrapThreadCommand` accepts the services it needs as parameters.
 */
import { Cause, Effect, Schema } from "effect";
import {
  CommandId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  OrchestrationDispatchCommandError,
  type GitCreateWorktreeInput,
  type GitCreateWorktreeResult,
  type GitServiceError,
} from "@bigbud/contracts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type {
  ProjectSetupScriptRunnerInput,
  ProjectSetupScriptRunnerResult,
} from "../project/Services/ProjectSetupScriptRunner.ts";
import { resolveWorkspaceExecutionTargetId } from "../workspace-target/workspaceTarget.ts";

export type BootstrapServices = {
  readonly orchestrationEngine: {
    dispatch: (
      cmd: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError>;
    getReadModel: () => Effect.Effect<OrchestrationReadModel, never>;
  };
  readonly git: {
    createWorktree: (
      input: GitCreateWorktreeInput,
    ) => Effect.Effect<GitCreateWorktreeResult, GitServiceError>;
  };
  readonly projectSetupScriptRunner: {
    runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, Error>;
  };
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>;
};

export function makeDispatchBootstrapThreadCommand(
  orchestrationEngine: BootstrapServices["orchestrationEngine"],
  git: BootstrapServices["git"],
  projectSetupScriptRunner: BootstrapServices["projectSetupScriptRunner"],
  refreshGitStatus: BootstrapServices["refreshGitStatus"],
  appendSetupScriptActivity: (input: {
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>,
  serverCommandId: (tag: string) => CommandId,
) {
  return function dispatchBootstrapThreadCommand(
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" | "thread.shell.run" }>,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> {
    return Effect.gen(function* () {
      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      let targetProjectId = bootstrap?.createThread?.projectId;
      let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const resolveTargetProject = () =>
        orchestrationEngine.getReadModel().pipe(
          Effect.map((readModel) => {
            const readModelThread =
              targetProjectId === undefined && targetProjectCwd === undefined
                ? (readModel.threads.find((entry) => entry.id === command.threadId) ?? null)
                : null;
            const nextProjectId = targetProjectId ?? readModelThread?.projectId ?? null;
            const project =
              (nextProjectId
                ? readModel.projects.find((entry) => entry.id === nextProjectId)
                : null) ??
              (targetProjectCwd
                ? readModel.projects.find((entry) => entry.workspaceRoot === targetProjectCwd)
                : null) ??
              null;

            if (project) {
              targetProjectId = project.id;
              targetProjectCwd = project.workspaceRoot ?? undefined;
            }

            return project;
          }),
        );

      const cleanupCreatedThread = () =>
        createdThread
          ? orchestrationEngine
              .dispatch({
                type: "thread.delete",
                commandId: serverCommandId("bootstrap-thread-delete"),
                threadId: command.threadId,
              })
              .pipe(Effect.ignoreCause({ log: true }))
          : Effect.void;

      const recordSetupScriptLaunchFailure = (input: {
        readonly error: unknown;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail =
          input.error instanceof Error ? input.error.message : "Unknown setup failure.";
        return appendSetupScriptActivity({
          threadId: command.threadId,
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          createdAt: input.requestedAt,
          payload: { detail, worktreePath: input.worktreePath },
          tone: "error",
        }).pipe(
          Effect.ignoreCause({ log: false }),
          Effect.flatMap(() =>
            Effect.logWarning("bootstrap turn start failed to launch setup script", {
              threadId: command.threadId,
              worktreePath: input.worktreePath,
              detail,
            }),
          ),
        );
      };

      const recordSetupScriptStarted = (input: {
        readonly requestedAt: string;
        readonly worktreePath: string;
        readonly scriptId: string;
        readonly scriptName: string;
        readonly terminalId: string;
      }) => {
        const payload = {
          scriptId: input.scriptId,
          scriptName: input.scriptName,
          terminalId: input.terminalId,
          worktreePath: input.worktreePath,
        };
        return Effect.all([
          appendSetupScriptActivity({
            threadId: command.threadId,
            kind: "setup-script.requested",
            summary: "Starting setup script",
            createdAt: input.requestedAt,
            payload,
            tone: "info",
          }),
          appendSetupScriptActivity({
            threadId: command.threadId,
            kind: "setup-script.started",
            summary: "Setup script started",
            createdAt: new Date().toISOString(),
            payload,
            tone: "info",
          }),
        ]).pipe(Effect.asVoid, Effect.ignoreCause({ log: true }));
      };

      const runSetupProgram = () =>
        bootstrap?.runSetupScript && targetWorktreePath
          ? (() => {
              const worktreePath = targetWorktreePath;
              const requestedAt = new Date().toISOString();
              return projectSetupScriptRunner
                .runForThread({
                  threadId: command.threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error: unknown) =>
                      recordSetupScriptLaunchFailure({ error, requestedAt, worktreePath }),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") return Effect.void;
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      });
                    },
                  }),
                );
            })()
          : Effect.void;

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread) {
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: serverCommandId("bootstrap-thread-create"),
            threadId: command.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            ...(bootstrap.createThread.providerRuntimeExecutionTargetId
              ? {
                  providerRuntimeExecutionTargetId:
                    bootstrap.createThread.providerRuntimeExecutionTargetId,
                }
              : {}),
            ...(bootstrap.createThread.workspaceExecutionTargetId
              ? {
                  workspaceExecutionTargetId: bootstrap.createThread.workspaceExecutionTargetId,
                }
              : {}),
            ...(bootstrap.createThread.executionTargetId
              ? { executionTargetId: bootstrap.createThread.executionTargetId }
              : {}),
            modelSelection: bootstrap.createThread.modelSelection,
            runtimeMode: bootstrap.createThread.runtimeMode,
            interactionMode: bootstrap.createThread.interactionMode,
            branch: bootstrap.createThread.branch,
            worktreePath: bootstrap.createThread.worktreePath,
            createdAt: bootstrap.createThread.createdAt,
          });
          createdThread = true;
        }

        if (bootstrap?.prepareWorktree) {
          const project = yield* resolveTargetProject();
          const worktree = yield* git.createWorktree({
            cwd: bootstrap.prepareWorktree.projectCwd,
            ...(project ? { executionTargetId: resolveWorkspaceExecutionTargetId(project) } : {}),
            branch: bootstrap.prepareWorktree.baseBranch,
            newBranch: bootstrap.prepareWorktree.branch,
            path: null,
          });
          targetWorktreePath = worktree.worktree.path;
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("bootstrap-thread-meta-update"),
            threadId: command.threadId,
            branch: worktree.worktree.branch,
            worktreePath: targetWorktreePath,
          });
          yield* refreshGitStatus(targetWorktreePath).pipe(Effect.ignoreCause({ log: true }));
        }

        yield* runSetupProgram();

        return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
      });

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return Schema.is(OrchestrationDispatchCommandError)(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread command.",
              cause,
            });
      };

      return yield* bootstrapProgram.pipe(
        Effect.catchCause((cause) => {
          const dispatchError = toBootstrapDispatchCommandCauseError(cause);
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.fail(dispatchError);
          }
          return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
        }),
      );
    });
  };
}
