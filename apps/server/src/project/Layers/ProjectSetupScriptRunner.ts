import { projectScriptRuntimeEnv, setupProjectScript } from "@bigbud/shared/projectScripts";
import { assertTerminalCommandContext } from "@bigbud/shared/terminalCommand";
import { ProjectId } from "@bigbud/contracts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalLimitError } from "@bigbud/contracts/workspace/terminal.limit.ts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";

import {
  ensureOrchestrationProjectState,
  ensureOrchestrationWorkspaceProjects,
  OrchestrationEngineService,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { resolveWorkspaceExecutionTargetId } from "../../workspace-target/workspaceTarget.ts";
import {
  type ProjectSetupScriptRunnerInput,
  type ProjectSetupScriptRunnerShape,
  ProjectSetupScriptRunner,
} from "../Services/ProjectSetupScriptRunner.ts";
import { PendingProjectSetups } from "./ProjectSetupScriptRunner.pending.ts";

const SETUP_INPUTS_GONE =
  "The setup inputs are no longer available. Run the setup script again from the project menu.";

/** The amber setup toast with "Close oldest and run setup" (plan §8.8, §11.3). */
function setupBlockedNotice(
  input: { readonly threadId: string },
  error: TerminalLimitError,
): TerminalLifecycleNotice {
  return {
    type: "lifecycleNotice",
    noticeId: `setup-limit:${input.threadId}:${Date.now()}`.slice(0, 128),
    kind: "setupBlockedByLimit",
    threadId: input.threadId,
    ...(error.candidate ? { candidate: error.candidate } : {}),
    limit: error.limit,
    createdAt: new Date().toISOString(),
  };
}

const isTerminalLimitError = Schema.is(TerminalLimitError);

function withoutEvict(input: ProjectSetupScriptRunnerInput): ProjectSetupScriptRunnerInput {
  const { evict: _evict, ...rest } = input;
  return rest;
}

const makeProjectSetupScriptRunner = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const terminalManager = yield* TerminalManager;
  const pending = new PendingProjectSetups();

  const runForThread: ProjectSetupScriptRunnerShape["runForThread"] = (input) =>
    Effect.gen(function* () {
      if (input.projectId)
        yield* ensureOrchestrationProjectState(
          orchestrationEngine,
          ProjectId.makeUnsafe(input.projectId),
        );
      else if (input.projectCwd)
        yield* ensureOrchestrationWorkspaceProjects(orchestrationEngine, input.projectCwd);
      const readModel = yield* orchestrationEngine.getReadModel();
      const project =
        (input.projectId
          ? readModel.projects.find((entry) => entry.id === input.projectId)
          : null) ??
        (input.projectCwd
          ? readModel.projects.find((entry) => entry.workspaceRoot === input.projectCwd)
          : null) ??
        null;

      if (!project) {
        return yield* Effect.fail(new Error("Project was not found for setup script execution."));
      }
      if (!project.workspaceRoot) {
        return {
          status: "no-script",
        } as const;
      }

      const script = setupProjectScript(project.scripts);
      if (!script) {
        return {
          status: "no-script",
        } as const;
      }

      const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
      const cwd = input.worktreePath;
      const env = projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: input.worktreePath,
      });

      const openInput = {
        threadId: input.threadId,
        terminalId,
        executionTargetId: resolveWorkspaceExecutionTargetId(project),
        cwd,
        worktreePath: input.worktreePath,
        env,
      };
      const opened = yield* terminalManager
        .open({ ...openInput, ...(input.evict ? { evict: input.evict } : {}) })
        .pipe(
          Effect.tapError((error) =>
            isTerminalLimitError(error)
              ? Effect.andThen(
                  Effect.sync(() =>
                    pending.remember(input.threadId, {
                      input: withoutEvict(input),
                      cwd,
                      env,
                      scriptId: script.id,
                    }),
                  ),
                  terminalManager.publishLifecycleNotice?.(setupBlockedNotice(input, error)) ??
                    Effect.void,
                )
              : Effect.void,
          ),
        );
      yield* Effect.try({
        try: () => assertTerminalCommandContext(opened, openInput),
        catch: (error) =>
          new TerminalExecutionTargetError({
            threadId: input.threadId,
            terminalId,
            executionTargetId: openInput.executionTargetId,
            detail:
              error instanceof Error
                ? error.message
                : "Could not verify the setup terminal launch context.",
            cause: error,
          }),
      });
      yield* terminalManager.write({
        threadId: input.threadId,
        terminalId,
        data: `${script.command}\r`,
      });

      return {
        status: "started",
        scriptId: script.id,
        scriptName: script.name,
        terminalId,
        cwd,
      } as const;
    });

  const retryBlockedSetup: NonNullable<ProjectSetupScriptRunnerShape["retryBlockedSetup"]> = (
    input,
  ) =>
    Effect.gen(function* () {
      const stored = pending.take(input.threadId);
      if (stored) return yield* runForThread({ ...stored.input, evict: input.evict });
      // Backend restarted or the entry expired: the thread's worktree and project still say it.
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === input.threadId);
      if (!thread?.worktreePath) return yield* Effect.fail(new Error(SETUP_INPUTS_GONE));
      return yield* runForThread({
        threadId: input.threadId,
        projectId: thread.projectId,
        worktreePath: thread.worktreePath,
        evict: input.evict,
      });
    });

  return {
    runForThread,
    retryBlockedSetup,
  } satisfies ProjectSetupScriptRunnerShape;
});

export const ProjectSetupScriptRunnerLive = Layer.effect(
  ProjectSetupScriptRunner,
  makeProjectSetupScriptRunner,
);
