import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";

import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type {
  ProjectSetupScriptRunnerInput,
  ProjectSetupScriptRunnerResult,
} from "../project/Services/ProjectSetupScriptRunner.ts";

export type AppendBootstrapSetupActivity = (input: {
  readonly parentCommandId: CommandId;
  readonly threadId: ThreadId;
  readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
  readonly summary: string;
  readonly createdAt: string;
  readonly payload: Record<string, unknown>;
  readonly tone: "info" | "error";
}) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>;

export function runBootstrapSetupScript(input: {
  readonly parentCommandId: CommandId;
  readonly setup: ProjectSetupScriptRunnerInput & { readonly threadId: ThreadId };
  readonly runForThread: (
    setup: ProjectSetupScriptRunnerInput,
  ) => Effect.Effect<ProjectSetupScriptRunnerResult, Error>;
  readonly appendActivity: AppendBootstrapSetupActivity;
}) {
  const requestedAt = new Date().toISOString();
  const { threadId, worktreePath } = input.setup;
  const activity = { parentCommandId: input.parentCommandId, threadId };
  return input.runForThread(input.setup).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const detail = error instanceof Error ? error.message : "Unknown setup failure.";
        return input
          .appendActivity({
            ...activity,
            kind: "setup-script.failed",
            summary: "Setup script failed to start",
            createdAt: requestedAt,
            payload: { detail, worktreePath },
            tone: "error",
          })
          .pipe(
            Effect.ignoreCause({ log: false }),
            Effect.flatMap(() =>
              Effect.logWarning("bootstrap turn start failed to launch setup script", {
                threadId,
                worktreePath,
                detail,
              }),
            ),
          );
      },
      onSuccess: (result) => {
        if (result.status !== "started") return Effect.void;
        const payload = {
          scriptId: result.scriptId,
          scriptName: result.scriptName,
          terminalId: result.terminalId,
          worktreePath,
        };
        return Effect.all([
          input.appendActivity({
            ...activity,
            kind: "setup-script.requested",
            summary: "Starting setup script",
            createdAt: requestedAt,
            payload,
            tone: "info",
          }),
          input.appendActivity({
            ...activity,
            kind: "setup-script.started",
            summary: "Setup script started",
            createdAt: new Date().toISOString(),
            payload,
            tone: "info",
          }),
        ]).pipe(Effect.asVoid, Effect.ignoreCause({ log: true }));
      },
    }),
  );
}
