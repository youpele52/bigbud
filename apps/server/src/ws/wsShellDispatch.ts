import {
  DEFAULT_SERVER_SETTINGS,
  LOCAL_EXECUTION_TARGET_ID,
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  MessageId,
  type ServerSettings,
  ServerSettingsError,
} from "@bigbud/contracts";
import { Data, Effect, Queue } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils";
import type { OrchestrationDispatchError } from "../orchestration/Errors";
import type { ThreadShellRunnerShape } from "../shell/Services/ThreadShellRunner";
import type { ServerRuntimeStartupError } from "../startup/serverRuntimeStartup";
import { formatRemoteExecutionTargetDetail, isLocalExecutionTarget } from "../executionTargets";
import { resolveWorkspaceExecutionTargetId } from "../workspace-target/workspaceTarget";
import { resolveDefaultChatCwd } from "./serverSettings";
import {
  consumeShellOutputEvents,
  dispatchShellAssistantDelta,
  type ShellOutputEvent,
} from "./wsShellDispatch.events";
import {
  ShellOutputAccumulator,
  SHELL_OUTPUT_BATCH_FLUSH_MS,
  SHELL_OUTPUT_BATCH_MAX_BYTES,
} from "./wsShellDispatch.shellOutput";

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
  readonly threadShellRunner: ThreadShellRunnerShape;
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
    threadShellRunner,
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
        const services = yield* Effect.services();
        const runFork = Effect.runForkWith(services);
        const runPromise = Effect.runPromiseWith(services);
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
        const activeProjectId = thread?.projectId ?? bootstrapProjectId;
        const activeProject =
          activeProjectId === null
            ? null
            : (readModel.projects.find(
                (project: OrchestrationReadModel["projects"][number]) =>
                  project.id === activeProjectId,
              ) ?? null);
        const executionTargetId =
          (thread ? resolveWorkspaceExecutionTargetId(thread) : undefined) ??
          (normalizedCommand.bootstrap?.createThread
            ? resolveWorkspaceExecutionTargetId(normalizedCommand.bootstrap.createThread)
            : undefined) ??
          (activeProject ? resolveWorkspaceExecutionTargetId(activeProject) : undefined) ??
          LOCAL_EXECUTION_TARGET_ID;

        if (!isLocalExecutionTarget(executionTargetId)) {
          return yield* new OrchestrationDispatchCommandError({
            message: formatRemoteExecutionTargetDetail({
              executionTargetId,
              surface: "Shell commands",
            }),
          });
        }

        const bootstrapProjectCwd =
          normalizedCommand.bootstrap?.prepareWorktree?.projectCwd ??
          activeProject?.workspaceRoot ??
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
        const messageId = MessageId.makeUnsafe(crypto.randomUUID());
        const outputQueue = yield* Queue.unbounded<ShellOutputEvent>();
        let pendingOutputEvent = Promise.resolve();
        const enqueueOutputEvent = (event: ShellOutputEvent): void => {
          pendingOutputEvent = pendingOutputEvent
            .then(() => runPromise(Queue.offer(outputQueue, event).pipe(Effect.asVoid)))
            .catch(() => undefined);
        };
        const shellOutput = new ShellOutputAccumulator(normalizedCommand.shellCommand);
        let pendingBatch = "";
        let batchTimer: ReturnType<typeof setTimeout> | null = null;
        let receivedChunkOutput = false;
        const clearBatchTimer = (): void => {
          if (batchTimer !== null) {
            clearTimeout(batchTimer);
            batchTimer = null;
          }
        };
        const flushPendingBatch = (): void => {
          clearBatchTimer();
          if (pendingBatch.length === 0) {
            return;
          }
          const batch = pendingBatch;
          pendingBatch = "";
          const update = shellOutput.ingest(batch);
          if (!update) {
            return;
          }
          enqueueOutputEvent({
            type: update.dispatch,
            text: update.text,
          });
        };
        const queueShellChunk = (chunk: string): void => {
          if (chunk.length === 0) {
            return;
          }

          pendingBatch += chunk;
          if (Buffer.byteLength(pendingBatch, "utf-8") >= SHELL_OUTPUT_BATCH_MAX_BYTES) {
            flushPendingBatch();
            return;
          }

          if (batchTimer !== null) {
            return;
          }

          batchTimer = setTimeout(() => {
            batchTimer = null;
            flushPendingBatch();
          }, SHELL_OUTPUT_BATCH_FLUSH_MS);
        };

        runFork(
          consumeShellOutputEvents({
            outputQueue,
            orchestrationEngine,
            serverCommandId,
            toDispatchCommandError,
            threadId: normalizedCommand.threadId,
            messageId,
          }).pipe(Effect.ignoreCause({ log: true })),
        );

        yield* dispatchShellAssistantDelta({
          orchestrationEngine,
          serverCommandId,
          toDispatchCommandError,
          threadId: normalizedCommand.threadId,
          messageId,
          delta: `$ ${normalizedCommand.shellCommand}`,
        });

        runFork(
          threadShellRunner
            .run({
              threadId: normalizedCommand.threadId,
              cwd,
              command: normalizedCommand.shellCommand,
              timeoutMs: null,
              onOutputChunk: (chunk) => {
                receivedChunkOutput = true;
                queueShellChunk(chunk);
              },
            })
            .pipe(
              Effect.tap((shellResult) =>
                Effect.sync(() => {
                  flushPendingBatch();
                  if (receivedChunkOutput || shellResult.output.length === 0) {
                    return;
                  }
                  const update = shellOutput.ingest(shellResult.output);
                  if (update) {
                    enqueueOutputEvent({
                      type: update.dispatch,
                      text: update.text,
                    });
                  }
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new ShellCommandExecutionError({
                    message:
                      cause instanceof Error ? cause.message : "Failed to run shell command.",
                    cause,
                  }),
              ),
              Effect.catchTag("ShellCommandExecutionError", (error) =>
                Effect.sync(() => {
                  flushPendingBatch();
                  const update = shellOutput.ingest(`\n${error.message}\n`);
                  if (update) {
                    enqueueOutputEvent({
                      type: update.dispatch,
                      text: update.text,
                    });
                  }
                }),
              ),
              Effect.ensuring(
                Effect.promise(async () => {
                  flushPendingBatch();
                  await shellOutput.close();
                  enqueueOutputEvent({ type: "complete" });
                  await pendingOutputEvent;
                }),
              ),
              Effect.ignoreCause({ log: true }),
            ),
        );

        return dispatchResult;
      }),
    );
