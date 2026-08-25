import {
  type OrchestrationThread,
  DEFAULT_RUNTIME_MODE,
  EventId,
  ThreadId,
  type OrchestrationSession,
  type ProviderSession,
} from "@bigbud/contracts";
import { Cause, Duration, Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BrowserManager } from "../../browser/Services/BrowserManager.ts";
import { finalizeThreadCanonicalHistory } from "../../deletion/Layers/CanonicalThreadCleanup.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { ThreadDeletionOperationError } from "../../deletion/Services/ThreadDeletion.ts";
import { threadSubtreeHasLiveActiveRuntime } from "../../deletion/Services/ThreadDeletion.preflight.ts";
import { ThreadShellRunner } from "../../shell/Services/ThreadShellRunner.ts";

type DeleteRequestedEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  { type: "thread.deletion-requested" }
>;

interface DeletionDeps {
  readonly resolveThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  readonly setThreadSession: (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchError>;
}

export function resolveDeletionRequestMode(
  requestedMode: "single" | "subtree" | undefined,
): "single" | "subtree" {
  return requestedMode ?? "subtree";
}

const STEP_TIMEOUT = Duration.seconds(15);

function describeFailures(
  failures: ReadonlyArray<{
    readonly step: "provider" | "browser" | "terminal" | "shell";
    readonly detail: string;
  }>,
): string {
  return failures.map((failure) => failure.step).join(", ");
}

export const makeProcessDeletionRequested = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const browser = yield* BrowserManager;
  const terminal = yield* TerminalManager;
  const shell = yield* Effect.serviceOption(ThreadShellRunner);
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const sql = yield* SqlClient.SqlClient;
  const appendDeletionFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly detail: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("thread-delete-failed-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "thread.delete.failed",
        summary: "Thread deletion failed",
        payload: {
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const makeStoppedSession = (input: {
    readonly threadId: ThreadId;
    readonly occurredAt: string;
    readonly threadSession: import("@bigbud/contracts").OrchestrationThread["session"];
    readonly liveSession: ProviderSession | undefined;
  }): OrchestrationSession => ({
    threadId: input.threadId,
    status: "stopped",
    providerName: input.threadSession?.providerName ?? input.liveSession?.provider ?? null,
    runtimeMode:
      input.threadSession?.runtimeMode ?? input.liveSession?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    activeTurnId: null,
    lastError: input.threadSession?.lastError ?? input.liveSession?.lastError ?? null,
    updatedAt: input.occurredAt,
  });

  const runCleanupStepOnce = <A, E, R>(
    step: "provider" | "browser" | "terminal" | "shell",
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.timeout(STEP_TIMEOUT),
      Effect.exit,
      Effect.map((exit) =>
        exit._tag === "Failure"
          ? {
              ok: false as const,
              step,
              detail: Cause.pretty(exit.cause),
            }
          : { ok: true as const, step },
      ),
    );
  const runCleanupStep = <A, E, R>(
    step: "provider" | "browser" | "terminal" | "shell",
    effect: () => Effect.Effect<A, E, R>,
  ) =>
    runCleanupStepOnce(step, effect()).pipe(
      Effect.flatMap((first) =>
        first.ok ? Effect.succeed(first) : runCleanupStepOnce(step, effect()),
      ),
    );

  return Effect.fn("processDeletionRequested")(function* (
    deps: DeletionDeps,
    event: DeleteRequestedEvent,
  ) {
    const mode = resolveDeletionRequestMode(event.payload.mode);
    const thread = yield* deps.resolveThread(event.payload.threadId);
    if (!thread || thread.deletedAt !== null) {
      yield* orchestrationEngine.threadDeletion!.releaseFence(event.payload.threadId, mode);
      return;
    }
    if (
      mode === "single" &&
      (yield* orchestrationEngine.threadDeletion!.isFenceRoot(thread.id, "subtree"))
    ) {
      return;
    }
    const fenceAlreadyHeld = yield* orchestrationEngine.threadDeletion!.isFenceRoot(
      thread.id,
      mode,
    );

    const outcome = yield* orchestrationEngine.threadDeletion!.deleteNow({
      rootThreadId: thread.id,
      mode,
      fenceAlreadyHeld,
      resolveThreads: () =>
        orchestrationEngine.getReadModel().pipe(Effect.map((model) => model.threads)),
      preflight: (threads) =>
        Effect.gen(function* () {
          if (threads.some((candidate) => candidate.pinnedAt !== null)) return "pinned" as const;
          const liveSessions = yield* providerService.listSessions();
          return threadSubtreeHasLiveActiveRuntime({ threads, liveSessions })
            ? ("active" as const)
            : undefined;
        }).pipe(
          Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
        ),
      teardown: (candidate) =>
        Effect.gen(function* () {
          const liveSessions = yield* providerService.listSessions();
          const liveSession = liveSessions.find((session) => session.threadId === candidate.id);
          const providerCleanup =
            liveSession !== undefined
              ? providerService.stopSession({ threadId: candidate.id }).pipe(
                  Effect.andThen(
                    deps.setThreadSession({
                      threadId: candidate.id,
                      session: makeStoppedSession({
                        threadId: candidate.id,
                        occurredAt: event.occurredAt,
                        threadSession: candidate.session,
                        liveSession,
                      }),
                      createdAt: event.occurredAt,
                    }),
                  ),
                )
              : candidate.session && candidate.session.status !== "stopped"
                ? deps.setThreadSession({
                    threadId: candidate.id,
                    session: makeStoppedSession({
                      threadId: candidate.id,
                      occurredAt: event.occurredAt,
                      threadSession: candidate.session,
                      liveSession: undefined,
                    }),
                    createdAt: event.occurredAt,
                  })
                : Effect.void;
          const results = yield* Effect.all(
            [
              runCleanupStep("provider", () => providerCleanup),
              runCleanupStep("browser", () => browser.close(candidate.id)),
              runCleanupStep("terminal", () =>
                terminal.close({ threadId: candidate.id, deleteHistory: false }),
              ),
              runCleanupStep("shell", () =>
                Option.isSome(shell) ? shell.value.closeThread(candidate.id) : Effect.void,
              ),
            ],
            { concurrency: 1 },
          );
          const failures = results.filter((result) => !result.ok);
          if (failures.length > 0) {
            return yield* Effect.fail(
              new Error(`Runtime cleanup failed: ${describeFailures(failures)}.`),
            );
          }
        }).pipe(
          Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
        ),
      finalize: (threadIds) =>
        Effect.gen(function* () {
          const files = yield* orchestrationEngine.threadDeletion!.discoverFiles({
            rootThreadId: thread.id,
            threadIds,
          });
          const finalized = yield* orchestrationEngine.dispatch({
            type: "thread.delete.finalize",
            commandId: serverCommandId("thread-delete-finalize"),
            threadId: thread.id,
            threadIds,
            mode,
            createdAt: new Date().toISOString(),
          });
          yield* finalizeThreadCanonicalHistory({
            projectionPipeline,
            sql,
            threadId: thread.id,
            deletionSequence: finalized.sequence,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("thread canonical history cleanup deferred", {
                rootThreadId: thread.id,
                detail: String(error),
              }),
            ),
          );
          yield* Effect.forEach(
            threadIds,
            (threadId) =>
              terminal.close({ threadId, deleteHistory: true }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("thread deletion terminal history cleanup deferred", {
                    rootThreadId: thread.id,
                    threadId,
                    detail: String(error),
                  }),
                ),
              ),
            { concurrency: 1, discard: true },
          );
          const orphanedResources = yield* orchestrationEngine
            .threadDeletion!.cleanupFiles(files)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("thread deletion file cleanup deferred", {
                  rootThreadId: thread.id,
                  detail: String(error),
                }).pipe(Effect.as([{ resource: "files", detail: String(error) }])),
              ),
            );
          if (orphanedResources.length > 0) {
            yield* Effect.logWarning("thread deletion orphan resource cleanup required", {
              rootThreadId: thread.id,
              orphanedResources,
            });
          }
        }).pipe(
          Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
        ),
    });

    if (outcome.type !== "deleted") {
      const createdAt = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.delete.abort",
        commandId: serverCommandId("thread-delete-abort"),
        threadId: thread.id,
        mode,
        createdAt,
      });
      if (outcome.type === "failed") {
        yield* appendDeletionFailureActivity({
          threadId: thread.id,
          createdAt,
          detail: outcome.detail,
        }).pipe(Effect.asVoid);
      }
    }
  });
});
