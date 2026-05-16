import { Effect, Schema } from "effect";
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
import { ProviderRegistry } from "../provider/Services/ProviderRegistry";
import { ProviderService } from "../provider/Services/ProviderService.ts";
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

export const makeWsRpcContext = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
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
  const startup = yield* ServerRuntimeStartup;
  const workspaceEntries = yield* WorkspaceEntries;
  const workspaceFileSystem = yield* WorkspaceFileSystem;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;

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

  const loadServerConfig = Effect.gen(function* () {
    const keybindingsConfig = yield* keybindings.loadConfigState;
    const providers = yield* providerRegistry.getProviders;
    const discovery = yield* discoveryRegistry.getCatalog;
    const rawSettings = yield* serverSettings.getSettings;
    const settings = resolveTextGenByProbeStatus(rawSettings, providers);

    return {
      cwd: config.cwd,
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
    assertLocalGitExecutionTarget,
    checkpointDiffQuery,
    config,
    dispatchNormalizedCommand,
    dispatchShellCommand,
    discoveryRegistry,
    git,
    gitManager,
    gitStatusBroadcaster,
    keybindings,
    lifecycleEvents,
    loadServerConfig,
    normalizeDispatchCommand,
    open,
    orchestrationEngine,
    projectSetupScriptRunner,
    projectionSnapshotQuery,
    providerRegistry,
    providerService,
    refreshGitStatus,
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
