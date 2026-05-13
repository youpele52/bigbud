import {
  DEFAULT_SERVER_SETTINGS,
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  MessageId,
  type ServerSettings,
  ServerSettingsError,
} from "@bigbud/contracts";
import { Data, Effect } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils";
import type { OrchestrationDispatchError } from "../orchestration/Errors";
import type { ServerRuntimeStartupError } from "../startup/serverRuntimeStartup";
import { runShellCommand } from "../utils/runShellCommand";
import { resolveDefaultChatCwd } from "./serverSettings";

class ShellCommandExecutionError extends Data.TaggedError("ShellCommandExecutionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface DispatchShellCommandServices {
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
  readonly dispatchInitialShellCommand: (
    command: Extract<OrchestrationCommand, { type: "thread.shell.run" }>,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  readonly orchestrationEngine: {
    readonly dispatch: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError>;
    readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never>;
  };
  readonly serverSettings: {
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  };
  readonly serverCommandId: (tag: string) => OrchestrationCommand["commandId"];
  readonly toDispatchCommandError: (
    cause: unknown,
    fallbackMessage: string,
  ) => OrchestrationDispatchCommandError;
}

const THREAD_READ_MODEL_WAIT_ATTEMPTS = 50;
const THREAD_READ_MODEL_WAIT_INTERVAL = "10 millis";

export const makeDispatchShellCommand =
  ({
    enqueueCommand,
    dispatchInitialShellCommand,
    orchestrationEngine,
    serverSettings,
    serverCommandId,
    toDispatchCommandError,
  }: DispatchShellCommandServices) =>
  (
    normalizedCommand: Extract<OrchestrationCommand, { type: "thread.shell.run" }>,
  ): Effect.Effect<
    { readonly sequence: number },
    OrchestrationDispatchCommandError | ServerRuntimeStartupError
  > =>
    enqueueCommand(
      Effect.gen(function* () {
        const dispatchResult = yield* dispatchInitialShellCommand(normalizedCommand);

        const readShellCommandThreadContext = (
          attemptsRemaining: number,
        ): Effect.Effect<{
          readonly readModel: OrchestrationReadModel;
          readonly thread: OrchestrationReadModel["threads"][number] | null;
        }> =>
          Effect.gen(function* () {
            const currentReadModel = yield* orchestrationEngine.getReadModel();
            const currentThread =
              currentReadModel.threads.find((entry) => entry.id === normalizedCommand.threadId) ??
              null;
            if (currentThread || attemptsRemaining <= 0) {
              return {
                readModel: currentReadModel,
                thread: currentThread,
              };
            }
            yield* Effect.sleep(THREAD_READ_MODEL_WAIT_INTERVAL);
            return yield* readShellCommandThreadContext(attemptsRemaining - 1);
          }).pipe(Effect.withSpan("readShellCommandThreadContext"));

        const { readModel, thread } = yield* readShellCommandThreadContext(
          THREAD_READ_MODEL_WAIT_ATTEMPTS,
        );

        const settings = yield* serverSettings.getSettings.pipe(
          Effect.catchTag("ServerSettingsError", () => Effect.succeed(DEFAULT_SERVER_SETTINGS)),
        );
        const bootstrapProjectId = normalizedCommand.bootstrap?.createThread?.projectId ?? null;
        const bootstrapProjectCwd =
          normalizedCommand.bootstrap?.prepareWorktree?.projectCwd ??
          readModel.projects.find(
            (project: OrchestrationReadModel["projects"][number]) =>
              project.id === bootstrapProjectId,
          )?.workspaceRoot ??
          null;
        const cwd =
          (thread
            ? resolveThreadWorkspaceCwd({
                thread,
                projects: readModel.projects,
              })
            : null) ??
          normalizedCommand.bootstrap?.createThread?.worktreePath ??
          bootstrapProjectCwd ??
          resolveDefaultChatCwd(settings);

        const shellResult = yield* Effect.tryPromise({
          try: () => runShellCommand(normalizedCommand.shellCommand, { cwd }),
          catch: (cause) =>
            new ShellCommandExecutionError({
              message: cause instanceof Error ? cause.message : "Failed to run shell command.",
              cause,
            }),
        }).pipe(
          Effect.catchTag("ShellCommandExecutionError", (error) =>
            Effect.succeed({ output: error.message }),
          ),
        );

        const output = `$ ${normalizedCommand.shellCommand}${
          shellResult.output.length > 0 ? `\n\n${shellResult.output}` : ""
        }`;
        const messageId = MessageId.makeUnsafe(crypto.randomUUID());
        const createdAt = new Date().toISOString();

        if (output.length > 0) {
          yield* orchestrationEngine
            .dispatch({
              type: "thread.message.assistant.delta",
              commandId: serverCommandId("shell-output-delta"),
              threadId: normalizedCommand.threadId,
              messageId,
              delta: output,
              createdAt,
            })
            .pipe(
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "Failed to append shell output."),
              ),
            );
        }

        yield* orchestrationEngine
          .dispatch({
            type: "thread.message.assistant.complete",
            commandId: serverCommandId("shell-output-complete"),
            threadId: normalizedCommand.threadId,
            messageId,
            createdAt: new Date().toISOString(),
          })
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to complete shell output message."),
            ),
          );

        return dispatchResult;
      }),
    );
