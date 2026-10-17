import { projectScriptRuntimeEnv, setupProjectScript } from "@bigbud/shared/projectScripts";
import { assertTerminalCommandContext } from "@bigbud/shared/terminalCommand";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { resolveWorkspaceExecutionTargetId } from "../../workspace-target/workspaceTarget.ts";
import {
  type ProjectSetupScriptRunnerShape,
  ProjectSetupScriptRunner,
} from "../Services/ProjectSetupScriptRunner.ts";

const makeProjectSetupScriptRunner = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const terminalManager = yield* TerminalManager;

  const runForThread: ProjectSetupScriptRunnerShape["runForThread"] = (input) =>
    Effect.gen(function* () {
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
      const opened = yield* terminalManager.open(openInput);
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

  return {
    runForThread,
  } satisfies ProjectSetupScriptRunnerShape;
});

export const ProjectSetupScriptRunnerLive = Layer.effect(
  ProjectSetupScriptRunner,
  makeProjectSetupScriptRunner,
);
