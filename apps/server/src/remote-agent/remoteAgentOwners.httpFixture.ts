import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { runRemoteWorkspaceProcess } from "../ws/http.threadTools.remoteWorkspace.ts";

/** Exercise authenticated-thread target resolution and the public tool transport on every retry. */
export function runRestartFixtureTool(
  invocationId: string,
  command = "secret-command",
  args = ["secret-file-content"],
) {
  return Effect.runPromise(
    runRemoteWorkspaceProcess({
      callerThreadId: ThreadId.makeUnsafe("fixture-thread"),
      request: {
        remoteInvocationId: invocationId,
        remoteCommand: command,
        remoteArgs: args,
      },
    }).pipe(
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () =>
          Effect.succeed({
            threads: [
              {
                id: "fixture-thread",
                projectId: "fixture-project",
                worktreePath: null,
                workspaceExecutionTargetId: "ssh:fixture",
              },
            ],
            projects: [
              {
                id: "fixture-project",
                workspaceRoot: "/workspace",
                workspaceExecutionTargetId: "ssh:fixture",
              },
            ],
          }),
      } as never),
    ),
  );
}
