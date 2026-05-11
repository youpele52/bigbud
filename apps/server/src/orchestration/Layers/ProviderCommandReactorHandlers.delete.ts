import {
  type OrchestrationThread,
  DEFAULT_RUNTIME_MODE,
  EventId,
  ThreadId,
  type OrchestrationSession,
  type ProviderSession,
} from "@bigbud/contracts";
import { Cause, Duration, Effect } from "effect";

import { BrowserManager, type BrowserManagerError } from "../../browser/Services/BrowserManager.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager, type TerminalError } from "../../terminal/Services/Manager.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";

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

const STEP_TIMEOUT = Duration.seconds(15);

function describeFailures(
  failures: ReadonlyArray<{
    readonly step: "provider" | "browser" | "terminal";
    readonly detail: string;
  }>,
): string {
  return failures.map((failure) => `${failure.step}: ${failure.detail}`).join("\n");
}

export const makeProcessDeletionRequested = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const browser = yield* BrowserManager;
  const terminal = yield* TerminalManager;

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

  const runCleanupStep = <A, R>(
    step: "provider" | "browser" | "terminal",
    effect: Effect.Effect<
      A,
      ProviderServiceError | OrchestrationDispatchError | BrowserManagerError | TerminalError,
      R
    >,
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

  return Effect.fn("processDeletionRequested")(function* (
    deps: DeletionDeps,
    event: DeleteRequestedEvent,
  ) {
    const thread = yield* deps.resolveThread(event.payload.threadId);
    if (!thread || thread.deletedAt !== null) {
      return;
    }

    const liveSessions = yield* providerService.listSessions();
    const liveSession = liveSessions.find((session) => session.threadId === thread.id);

    const providerCleanup =
      liveSession !== undefined
        ? providerService.stopSession({ threadId: thread.id }).pipe(
            Effect.andThen(
              deps.setThreadSession({
                threadId: thread.id,
                session: makeStoppedSession({
                  threadId: thread.id,
                  occurredAt: event.occurredAt,
                  threadSession: thread.session,
                  liveSession,
                }),
                createdAt: event.occurredAt,
              }),
            ),
          )
        : thread.session && thread.session.status !== "stopped"
          ? deps.setThreadSession({
              threadId: thread.id,
              session: makeStoppedSession({
                threadId: thread.id,
                occurredAt: event.occurredAt,
                threadSession: thread.session,
                liveSession: undefined,
              }),
              createdAt: event.occurredAt,
            })
          : Effect.void;

    const results = yield* Effect.all(
      [
        runCleanupStep("provider", providerCleanup),
        runCleanupStep("browser", browser.close(thread.id)),
        runCleanupStep("terminal", terminal.close({ threadId: thread.id, deleteHistory: true })),
      ],
      { concurrency: 1 },
    );

    const failures = results.filter((result) => !result.ok);
    if (failures.length > 0) {
      const detail = describeFailures(failures);
      const createdAt = new Date().toISOString();
      yield* appendDeletionFailureActivity({
        threadId: thread.id,
        createdAt,
        detail,
      }).pipe(Effect.asVoid);
      yield* orchestrationEngine.dispatch({
        type: "thread.delete.abort",
        commandId: serverCommandId("thread-delete-abort"),
        threadId: thread.id,
        createdAt,
      });
      return;
    }

    const createdAt = new Date().toISOString();
    yield* orchestrationEngine.dispatch({
      type: "thread.delete.finalize",
      commandId: serverCommandId("thread-delete-finalize"),
      threadId: thread.id,
      createdAt,
    });
  });
});
