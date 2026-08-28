import { Data, Deferred, Effect, Exit, Layer, Ref, Schedule, Scope, ServiceMap } from "effect";

import { ServerConfig } from "./config";
import { Keybindings } from "../keybindings/keybindings";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "../orchestration/Services/OrchestrationReactor";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerSettingsService } from "../ws/serverSettings";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService";
import { maybeOpenBrowser, runStartupPhase } from "./serverRuntimeStartup.browser.ts";
import { autoBootstrapWelcome } from "./serverRuntimeStartup.bootstrap.ts";
import { cleanupHandoffDocumentFiles } from "../ws/wsHandoffDocument.ts";
import { runLegacyPinnedThreadSettingsMigration } from "./LegacyPinnedThreadSettingsMigration.ts";
import { writeStartupStatus } from "./startupStatus.ts";
import { runThreadRetentionSettingsMigration } from "./ThreadRetentionSettingsMigration.ts";
import { ThreadRetention } from "../retention/Services/ThreadRetention.ts";
import {
  CommandAdmissionError,
  STARTUP_COMMAND_DEADLINE_MS,
  STARTUP_COMMAND_QUEUE_CAPACITY,
  makeBoundedCommandAdmission,
  withCommandAdmissionDeadline,
} from "../command-admission/CommandAdmission.ts";

export class ServerRuntimeStartupError extends Data.TaggedError("ServerRuntimeStartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerRuntimeStartupShape {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly markHttpListening: Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError | CommandAdmissionError>;
}

export class ServerRuntimeStartup extends ServiceMap.Service<
  ServerRuntimeStartup,
  ServerRuntimeStartupShape
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError | CommandAdmissionError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = (options?: {
  readonly capacity?: number;
  readonly deadlineMs?: number;
  readonly onCommandTaken?: () => Effect.Effect<void>;
  readonly onCommandEnqueued?: () => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
    const commandAdmission = yield* makeBoundedCommandAdmission<QueuedCommand>({
      capacity: options?.capacity ?? STARTUP_COMMAND_QUEUE_CAPACITY,
      queue: "startup-readiness",
    });
    const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

    const commandWorker = Effect.forever(
      commandAdmission.take.pipe(
        Effect.tap(() => options?.onCommandTaken?.() ?? Effect.void),
        Effect.flatMap((command) => command.run),
      ),
    );
    yield* Effect.forkScoped(commandWorker);

    return {
      awaitCommandReady: Deferred.await(commandReady),
      signalCommandReady: Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, "ready");
        yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
      }),
      failCommandReady: (error) =>
        Effect.gen(function* () {
          yield* Ref.set(commandReadinessState, error);
          yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
        }),
      enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const readinessState = yield* Ref.get(commandReadinessState);
          if (readinessState === "ready") {
            return yield* effect;
          }
          if (readinessState !== "pending") {
            return yield* readinessState;
          }

          const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
          yield* commandAdmission.offer({
            run: Deferred.await(commandReady).pipe(
              Effect.flatMap(() => effect),
              Effect.exit,
              Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
            ),
          });
          yield* options?.onCommandEnqueued?.() ?? Effect.void;
          return yield* withCommandAdmissionDeadline(Deferred.await(result), {
            queue: "startup-readiness",
            deadlineMs: options?.deadlineMs ?? STARTUP_COMMAND_DEADLINE_MS,
          });
        }),
    } satisfies CommandGate;
  });

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

export const launchStartupHeartbeat = recordStartupHeartbeat.pipe(
  Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
  Effect.withSpan("server.startup.heartbeat.record"),
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

const makeServerRuntimeStartup = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const keybindings = yield* Keybindings;
  const orchestrationReactor = yield* OrchestrationReactor;
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const serverSettings = yield* ServerSettingsService;
  const threadRetention = yield* Effect.serviceOption(ThreadRetention);
  const commandGate = yield* makeCommandGate();
  const httpListening = yield* Deferred.make<void>();
  const reactorScope = yield* Scope.make("sequential");

  yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

  const startup = Effect.gen(function* () {
    yield* Effect.logDebug("startup phase: starting keybindings runtime");
    yield* runStartupPhase(
      "keybindings.start",
      keybindings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start keybindings runtime", {
            path: error.configPath,
            detail: error.detail,
            cause: error.cause,
          }),
        ),
        Effect.forkScoped,
      ),
    );

    yield* Effect.logDebug("startup phase: starting server settings runtime");
    yield* runStartupPhase(
      "settings.start",
      serverSettings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start server settings runtime", {
            path: error.settingsPath,
            detail: error.detail,
            cause: error.cause,
          }),
        ),
        Effect.forkScoped,
      ),
    );
    yield* runStartupPhase("settings.ready", serverSettings.ready);

    yield* Effect.logDebug("startup phase: migrating thread retention settings");
    yield* runStartupPhase("retention.settings.migrate", runThreadRetentionSettingsMigration());

    yield* Effect.logDebug("startup phase: starting handoff document cleanup");
    yield* runStartupPhase(
      "handoff.cleanup.start",
      Effect.repeat(cleanupHandoffDocumentFiles(), Schedule.fixed("24 hours")).pipe(
        Effect.forkScoped,
      ),
    );

    yield* Effect.logDebug("startup phase: migrating legacy pinned threads");
    yield* runStartupPhase("pins.migrate", runLegacyPinnedThreadSettingsMigration());

    yield* Effect.logDebug("startup phase: starting orchestration reactors");
    yield* runStartupPhase(
      "reactors.start",
      orchestrationReactor.start().pipe(Scope.provide(reactorScope)),
    );

    yield* Effect.logDebug("startup phase: preparing welcome payload");
    const welcome = yield* runStartupPhase("welcome.prepare", autoBootstrapWelcome);
    yield* Effect.logDebug("startup phase: publishing welcome event", {
      cwd: welcome.cwd,
      projectName: welcome.projectName,
      bootstrapProjectId: welcome.bootstrapProjectId,
      bootstrapThreadId: welcome.bootstrapThreadId,
    });
    yield* runStartupPhase(
      "welcome.publish",
      lifecycleEvents.publish({
        version: 1,
        type: "welcome",
        payload: welcome,
      }),
    );
  }).pipe(
    Effect.annotateSpans({
      "server.mode": serverConfig.mode,
      "server.port": serverConfig.port,
      "server.host": serverConfig.host ?? "default",
    }),
    Effect.withSpan("server.startup", { kind: "server", root: true }),
  );

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const startupExit = yield* Effect.exit(startup);
      if (Exit.isFailure(startupExit)) {
        yield* Effect.sync(() => writeStartupStatus("error", "server_runtime_startup_failed"));
        const error = new ServerRuntimeStartupError({
          message: "Server runtime startup failed before command readiness.",
          cause: startupExit.cause,
        });
        yield* Effect.logError("server runtime startup failed", { cause: startupExit.cause });
        yield* commandGate.failCommandReady(error);
        return;
      }

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* Effect.sync(() => writeStartupStatus("ready"));
      yield* Effect.logDebug("startup phase: publishing ready event");
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: { at: new Date().toISOString() },
        }),
      );

      yield* Effect.logDebug("startup phase: recording startup heartbeat");
      yield* launchStartupHeartbeat;
      yield* Effect.yieldNow;
      if (threadRetention._tag === "Some") {
        yield* Effect.forkScoped(threadRetention.value.start);
      }
      yield* Effect.logDebug("startup phase: browser open check");
      yield* runStartupPhase("browser.open", maybeOpenBrowser);
      yield* Effect.logDebug("startup phase: complete");
    }),
  );

  return {
    awaitCommandReady: commandGate.awaitCommandReady,
    markHttpListening: Deferred.succeed(httpListening, undefined),
    enqueueCommand: commandGate.enqueueCommand,
  } satisfies ServerRuntimeStartupShape;
});

export const ServerRuntimeStartupLive = Layer.effect(
  ServerRuntimeStartup,
  makeServerRuntimeStartup,
);
