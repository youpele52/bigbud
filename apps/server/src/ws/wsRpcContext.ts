import { Effect, FileSystem, Option, Schema } from "effect";
import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  GitCommandError,
  type ThreadId,
} from "@bigbud/contracts";

import { CheckpointDiffQuery } from "../checkpointing/Services/CheckpointDiffQuery";
import { ServerConfig } from "../startup/config";
import { GitCore } from "../git/Services/GitCore";
import { GitManager } from "../git/Services/GitManager";
import { GitStatusBroadcaster } from "../git/Services/GitStatusBroadcaster";
import { Keybindings } from "../keybindings/keybindings";
import { Open, resolveAvailableEditors } from "../utils/open";
import { normalizeDispatchCommand } from "../orchestration/Normalizer";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProjectionCatalogQuery } from "../orchestration/Services/ProjectionCatalogQuery";
import { ProjectionOperationalStateQuery } from "../orchestration/Services/ProjectionOperationalStateQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { CliProxyLifecycle } from "../provider/Services/CliProxy/Lifecycle.ts";
import { activateCliProxyRuntime } from "../provider/Layers/CliProxy/RuntimeConfig.ts";
import { DiscoveryRegistry } from "../provider/Services/DiscoveryRegistry";
import { ThreadShellRunner } from "../shell/Services/ThreadShellRunner";
import { ServerLifecycleEvents } from "../startup/serverLifecycleEvents";
import { ServerRuntimeStartup } from "../startup/serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { TerminalManager } from "../terminal/Services/Manager";
import { WorkspaceEntries } from "../workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "../workspace/Services/WorkspaceFileSystem";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner";
import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap";
import { resolveTextGenByProbeStatus } from "./wsSettingsResolver";
import { makeDispatchShellCommand } from "./wsShellDispatch";
import { formatRemoteExecutionTargetDetail, isLocalExecutionTarget } from "../executionTargets";
import { ProjectionNoteRepository } from "../persistence/Services/ProjectionNotes";
import { ProjectionKanbanRepository } from "../persistence/Services/ProjectionKanban.ts";
import { AutomationScheduleRepository } from "../persistence/Services/AutomationScheduleRepository.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { SchedulerReactor } from "../orchestration/Services/SchedulerReactor.ts";
import { MobileRemoteControl } from "../mobile/Services/MobileRemoteControl.ts";
import { makeServerHandoffJobs } from "./wsHandoffJobs.ts";

class CliProxyActivationEffectError extends Schema.TaggedErrorClass<CliProxyActivationEffectError>()(
  "CliProxyActivationEffectError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

function toError(cause: unknown): CliProxyActivationEffectError {
  return Schema.is(CliProxyActivationEffectError)(cause)
    ? cause
    : new CliProxyActivationEffectError({
        detail: cause instanceof Error ? cause.message : "CLIProxyAPI activation failed.",
        cause,
      });
}

export function makeCoalescedPromiseEffect<A>(operation: () => Effect.Effect<A, Error>) {
  let inFlight: Promise<A> | undefined;
  return () => {
    if (inFlight) {
      return Effect.tryPromise({
        try: () => inFlight!,
        catch: toError,
      });
    }
    const promise = Effect.runPromise(operation()).finally(() => {
      inFlight = undefined;
    });
    inFlight = promise;
    return Effect.tryPromise({
      try: () => promise,
      catch: toError,
    });
  };
}

export const makeWsRpcContext = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionCatalogQuery = yield* ProjectionCatalogQuery;
  const projectionOperationalStateQuery = yield* Effect.serviceOption(
    ProjectionOperationalStateQuery,
  );
  const orchestrationEngine = yield* OrchestrationEngineService;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const keybindings = yield* Keybindings;
  const open = yield* Open;
  const gitManager = yield* GitManager;
  const git = yield* GitCore;
  const gitStatusBroadcaster = yield* GitStatusBroadcaster;
  const terminalManager = yield* TerminalManager;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const discoveryRegistry = yield* DiscoveryRegistry;
  const threadShellRunner = yield* ThreadShellRunner;
  const config = yield* ServerConfig;
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const serverSettings = yield* ServerSettingsService;
  const cliProxyLifecycleOption = yield* Effect.serviceOption(CliProxyLifecycle);
  const startup = yield* ServerRuntimeStartup;
  const workspaceEntries = yield* WorkspaceEntries;
  const workspaceFileSystem = yield* WorkspaceFileSystem;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
  const projectionNotes = yield* ProjectionNoteRepository;
  const projectionKanban = yield* ProjectionKanbanRepository;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const automationScheduleRepository = yield* AutomationScheduleRepository;
  const schedulerReactor = yield* SchedulerReactor;
  const mobileRemoteControl = yield* MobileRemoteControl;
  const fileSystem = yield* FileSystem.FileSystem;
  const handoffJobs = yield* makeServerHandoffJobs;

  const serverCommandId = (tag: string) =>
    CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

  const appendSetupScriptActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("setup-script-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
    Schema.is(OrchestrationDispatchCommandError)(cause)
      ? cause
      : new OrchestrationDispatchCommandError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          cause,
        });

  const refreshGitStatus = (cwd: string) =>
    gitManager.invalidateStatus(cwd).pipe(
      Effect.flatMap(() => gitStatusBroadcaster.invalidateLocal(cwd)),
      Effect.flatMap(() => gitStatusBroadcaster.invalidateRemote(cwd)),
    );

  const dispatchBootstrapThreadCommand = makeDispatchBootstrapThreadCommand(
    orchestrationEngine,
    git,
    projectSetupScriptRunner,
    refreshGitStatus,
    appendSetupScriptActivity,
    serverCommandId,
  );

  const assertLocalGitExecutionTarget = (
    cwd: string,
    executionTargetId: string | null | undefined,
    operation: string,
  ) =>
    isLocalExecutionTarget(executionTargetId)
      ? Effect.void
      : Effect.fail(
          new GitCommandError({
            operation,
            command: "execution-target",
            cwd,
            detail: formatRemoteExecutionTargetDetail({
              executionTargetId,
              surface: "Git execution",
            }),
          }),
        );

  const dispatchNormalizedCommand = (
    normalizedCommand: OrchestrationCommand,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
    const dispatchEffect =
      normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
        ? dispatchBootstrapThreadCommand(normalizedCommand)
        : orchestrationEngine
            .dispatch(normalizedCommand)
            .pipe(
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
              ),
            );

    return startup
      .enqueueCommand(dispatchEffect)
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
        ),
      );
  };

  const dispatchShellCommand = makeDispatchShellCommand({
    enqueueCommand: (effect) => startup.enqueueCommand(effect),
    dispatchInitialShellCommand: (normalizedCommand) =>
      normalizedCommand.bootstrap !== undefined
        ? dispatchBootstrapThreadCommand(normalizedCommand)
        : orchestrationEngine
            .dispatch(normalizedCommand)
            .pipe(
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "Failed to dispatch shell command"),
              ),
            ),
    orchestrationEngine,
    serverSettings,
    threadShellRunner,
    serverCommandId,
    toDispatchCommandError,
  });

  const activateCliProxy = makeCoalescedPromiseEffect(() =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      if (Option.isNone(cliProxyLifecycleOption)) {
        return yield* Effect.fail(new Error("CLIProxyAPI is not available in this server build."));
      }
      yield* Effect.tryPromise({
        try: () => activateCliProxyRuntime({ settings, lifecycle: cliProxyLifecycleOption.value }),
        catch: toError,
      });
      return yield* providerRegistry.refresh("cliProxy");
    }).pipe(Effect.mapError(toError)),
  );

  const loadServerConfig = Effect.gen(function* () {
    const keybindingsConfig = yield* keybindings.loadConfigState;
    const providers = yield* providerRegistry.getProviders;
    const discovery = yield* discoveryRegistry.getCatalog;
    const rawSettings = yield* serverSettings.getSettings;
    const settings = resolveTextGenByProbeStatus(rawSettings, providers);

    const skillBreakdown = new Map<string, number>();
    for (const skill of discovery.skills) {
      skillBreakdown.set(skill.provider, (skillBreakdown.get(skill.provider) ?? 0) + 1);
    }
    yield* Effect.logInfo(
      `[RPC] loadServerConfig → ${discovery.skills.length} skills, ${discovery.agents.length} agents. Provider breakdown: ${JSON.stringify([...skillBreakdown.entries()])}`,
    );

    return {
      cwd: config.cwd,
      storage: {
        notesDir: config.notesDir,
        kanbanDir: config.kanbanDir,
      },
      keybindingsConfigPath: config.keybindingsConfigPath,
      keybindings: keybindingsConfig.keybindings,
      issues: keybindingsConfig.issues,
      providers,
      discovery,
      availableEditors: resolveAvailableEditors(),
      observability: {
        logsDirectoryPath: config.logsDir,
        localTracingEnabled: true,
        ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
        otlpTracesEnabled: config.otlpTracesUrl !== undefined,
        ...(config.otlpMetricsUrl !== undefined ? { otlpMetricsUrl: config.otlpMetricsUrl } : {}),
        otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
      },
      settings,
    };
  });

  return {
    activateCliProxy,
    assertLocalGitExecutionTarget,
    automationScheduleRepository,
    checkpointDiffQuery,
    config,
    dispatchNormalizedCommand,
    dispatchShellCommand,
    discoveryRegistry,
    fileSystem,
    git,
    gitManager,
    gitStatusBroadcaster,
    handoffJobs,
    keybindings,
    lifecycleEvents,
    loadServerConfig,
    mobileRemoteControl,
    normalizeDispatchCommand,
    open,
    orchestrationEngine,
    projectSetupScriptRunner,
    projectionNotes,
    projectionKanban,
    projectionThreadRepository,
    projectionSnapshotQuery,
    projectionCatalogQuery,
    projectionOperationalStateQuery,
    providerRegistry,
    providerService,
    refreshGitStatus,
    schedulerReactor,
    serverCommandId,
    serverSettings,
    startup,
    terminalManager,
    threadShellRunner,
    toDispatchCommandError,
    workspaceEntries,
    workspaceFileSystem,
  };
});

export type WsRpcContext =
  typeof makeWsRpcContext extends Effect.Effect<infer A, any, any> ? A : never;
