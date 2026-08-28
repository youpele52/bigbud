/**
 * Bootstrap turn-start logic for the WebSocket RPC layer.
 *
 * Extracted from ws.ts to keep that file under 500 lines.
 * `dispatchBootstrapThreadCommand` accepts the services it needs as parameters.
 */
import { Cause, Effect } from "effect";
import {
  CommandId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  OrchestrationDispatchCommandError,
  type GetCommandOutcomeResult,
} from "@bigbud/contracts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { OrchestrationCommandReceiptRepositoryError } from "../persistence/Errors.ts";
import type { OrchestrationBootstrapRecipeRepositoryShape } from "../persistence/Services/OrchestrationBootstrapRecipes.ts";
import type {
  ProjectSetupScriptRunnerInput,
  ProjectSetupScriptRunnerResult,
} from "../project/Services/ProjectSetupScriptRunner.ts";
import { resolveWorkspaceExecutionTargetId } from "../workspace-target/workspaceTarget.ts";
import { toDispatchCommandError } from "./wsDispatchCommandError.ts";
import type { BootstrapCommandLock } from "./wsBootstrap.lock.ts";
import { claimBootstrapWorktreeRecipe } from "./wsBootstrap.recipe.ts";
import { ensureBootstrapWorktree, type BootstrapGit } from "./wsBootstrap.worktree.ts";

export type BootstrapServices = {
  readonly orchestrationEngine: {
    dispatch: (
      cmd: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError>;
    getReadModel: () => Effect.Effect<OrchestrationReadModel, never>;
    getCommandOutcome?: (
      commandId: CommandId,
    ) => Effect.Effect<GetCommandOutcomeResult, OrchestrationCommandReceiptRepositoryError>;
  };
  readonly git: BootstrapGit;
  readonly projectSetupScriptRunner: {
    runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, Error>;
  };
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>;
  readonly bootstrapRecipes: OrchestrationBootstrapRecipeRepositoryShape;
};

export type BootstrapWorktreeIdentity = {
  readonly path: string;
  readonly canonicalizePath: (path: string) => Effect.Effect<string | null>;
};

function isAcceptedThreadOutcome(
  outcome: GetCommandOutcomeResult,
  threadId: ThreadId,
  stage: string,
) {
  if (outcome.status !== "accepted") return false;
  if (outcome.aggregateKind === "thread" && outcome.aggregateId === threadId) return true;
  throw new Error(
    `Accepted ${stage} receipt belongs to ${outcome.aggregateKind}:${outcome.aggregateId}`,
  );
}

export function makeDispatchBootstrapThreadCommand(
  orchestrationEngine: BootstrapServices["orchestrationEngine"],
  git: BootstrapServices["git"],
  projectSetupScriptRunner: BootstrapServices["projectSetupScriptRunner"],
  refreshGitStatus: BootstrapServices["refreshGitStatus"],
  appendSetupScriptActivity: (input: {
    readonly parentCommandId: CommandId;
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>,
  serverCommandId: (parentCommandId: CommandId, tag: string) => CommandId,
  withBootstrapCommandLock: BootstrapCommandLock,
  resolveWorktreeIdentity?: (input: {
    readonly parentCommandId: CommandId;
    readonly projectCwd: string;
    readonly branch: string;
    readonly executionTargetId?: string;
  }) => BootstrapWorktreeIdentity | null,
  bootstrapRecipes?: BootstrapServices["bootstrapRecipes"],
) {
  return function dispatchBootstrapThreadCommand(
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" | "thread.shell.run" }>,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> {
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let targetProjectId = bootstrap?.createThread?.projectId;
      let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const getCommandOutcome = (commandId: CommandId) =>
        orchestrationEngine.getCommandOutcome
          ? orchestrationEngine.getCommandOutcome(commandId)
          : Effect.fail(new Error("Durable command outcome lookup is unavailable"));

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

      const recordSetupScriptLaunchFailure = (input: {
        readonly error: unknown;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail =
          input.error instanceof Error ? input.error.message : "Unknown setup failure.";
        return appendSetupScriptActivity({
          parentCommandId: command.commandId,
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
            parentCommandId: command.commandId,
            threadId: command.threadId,
            kind: "setup-script.requested",
            summary: "Starting setup script",
            createdAt: input.requestedAt,
            payload,
            tone: "info",
          }),
          appendSetupScriptActivity({
            parentCommandId: command.commandId,
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

      const runPostDispatchBootstrapEffects = () =>
        Effect.all(
          [
            targetWorktreePath
              ? refreshGitStatus(targetWorktreePath).pipe(Effect.ignoreCause({ log: true }))
              : Effect.void,
            runSetupProgram(),
          ],
          { concurrency: "unbounded", discard: true },
        );

      const bootstrapProgram = Effect.gen(function* () {
        const parentOutcome = yield* getCommandOutcome(command.commandId);
        if (parentOutcome.status !== "unknown") {
          isAcceptedThreadOutcome(parentOutcome, command.threadId, "bootstrap parent");
          return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
        }

        if (bootstrap?.createThread) {
          const createCommandId = serverCommandId(command.commandId, "bootstrap-thread-create");
          const createOutcome = yield* getCommandOutcome(createCommandId);
          if (!isAcceptedThreadOutcome(createOutcome, command.threadId, "thread-create child")) {
            yield* orchestrationEngine.dispatch({
              type: "thread.create",
              commandId: createCommandId,
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
          }
        }

        if (bootstrap?.prepareWorktree) {
          const metaCommandId = serverCommandId(command.commandId, "bootstrap-thread-meta-update");
          const metaOutcome = yield* getCommandOutcome(metaCommandId);
          if (isAcceptedThreadOutcome(metaOutcome, command.threadId, "metadata child")) {
            const readModel = yield* orchestrationEngine.getReadModel();
            const canonicalThread = readModel.threads.find(
              (thread) => thread.id === command.threadId,
            );
            if (!canonicalThread?.worktreePath) {
              throw new Error(
                "Committed bootstrap worktree metadata is missing from the canonical thread",
              );
            }
            targetProjectId = canonicalThread.projectId;
            targetWorktreePath = canonicalThread.worktreePath;
          } else {
            const project = yield* resolveTargetProject();
            const executionTargetId = project
              ? resolveWorkspaceExecutionTargetId(project)
              : undefined;
            const worktreeIdentity = bootstrap.prepareWorktree.branch
              ? null
              : resolveWorktreeIdentity?.({
                  parentCommandId: command.commandId,
                  projectCwd: bootstrap.prepareWorktree.projectCwd,
                  branch: bootstrap.prepareWorktree.baseBranch,
                  ...(executionTargetId ? { executionTargetId } : {}),
                });
            const createInput = {
              cwd: bootstrap.prepareWorktree.projectCwd,
              ...(executionTargetId ? { executionTargetId } : {}),
              branch: bootstrap.prepareWorktree.baseBranch,
              ...(bootstrap.prepareWorktree.branch
                ? { newBranch: bootstrap.prepareWorktree.branch }
                : {}),
              path: worktreeIdentity?.path ?? null,
            } as const;
            const recipe = yield* claimBootstrapWorktreeRecipe({
              repository: bootstrapRecipes,
              parentCommandId: command.commandId,
              createdAt: command.createdAt,
              executionTargetId: executionTargetId ?? null,
              projectId: targetProjectId ?? null,
              projectCwd: createInput.cwd,
              baseBranch: createInput.branch,
              requestedBranch: createInput.newBranch ?? null,
              deterministicWorktreePath: createInput.path,
            });
            targetProjectId = recipe.projectId ?? targetProjectId;
            targetProjectCwd = recipe.projectCwd;
            if (!recipe.requestedBranch && !recipe.deterministicWorktreePath) {
              throw new Error("Bootstrap worktree recipe lacks deterministic physical identity.");
            }
            // Generated branches are unique bootstrap identities. Existing
            // branches require the exact command-owned managed path so a retry
            // cannot adopt the primary checkout or another worktree.
            const persistedCreateInput = {
              cwd: recipe.projectCwd,
              ...(recipe.executionTargetId ? { executionTargetId: recipe.executionTargetId } : {}),
              branch: recipe.baseBranch,
              ...(recipe.requestedBranch ? { newBranch: recipe.requestedBranch } : {}),
              path: recipe.deterministicWorktreePath,
            } as const;
            const worktree = recipe.requestedBranch
              ? yield* ensureBootstrapWorktree({
                  git,
                  branch: recipe.requestedBranch,
                  createInput: persistedCreateInput,
                })
              : recipe.deterministicWorktreePath
                ? yield* ensureBootstrapWorktree({
                    git,
                    branch: recipe.baseBranch,
                    createInput: persistedCreateInput,
                    expectedPath: recipe.deterministicWorktreePath,
                    ...(worktreeIdentity?.canonicalizePath
                      ? { canonicalizePath: worktreeIdentity.canonicalizePath }
                      : {}),
                  })
                : yield* git.createWorktree(persistedCreateInput);
            targetWorktreePath = worktree.worktree.path;
            yield* orchestrationEngine.dispatch({
              type: "thread.meta.update",
              commandId: metaCommandId,
              threadId: command.threadId,
              branch: worktree.worktree.branch,
              worktreePath: targetWorktreePath,
            });
          }
        }

        const dispatchResult = yield* orchestrationEngine.dispatch(finalTurnStartCommand);
        runFork(runPostDispatchBootstrapEffects().pipe(Effect.ignoreCause({ log: true })));
        return dispatchResult;
      });

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return toDispatchCommandError(error, "Failed to bootstrap thread command.");
      };

      return yield* withBootstrapCommandLock(
        command.commandId,
        bootstrapProgram.pipe(
          Effect.catchCause((cause) => Effect.fail(toBootstrapDispatchCommandCauseError(cause))),
        ),
      );
    });
  };
}
