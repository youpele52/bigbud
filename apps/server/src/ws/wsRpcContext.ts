import { Effect, FileSystem, Option, Stream } from "effect";
import { GitCommandError } from "@bigbud/contracts";
import { ServerThreadRetentionError } from "@bigbud/contracts/server/threadRetention.ts";

import { CheckpointDiffQuery } from "../checkpointing/Services/CheckpointDiffQuery";
import { ServerConfig } from "../startup/config";
import { GitCore } from "../git/Services/GitCore";
import { GitManager, type GitManagerShape } from "../git/Services/GitManager";
import { GitStatusBroadcaster } from "../git/Services/GitStatusBroadcaster";
import { makeRemoteGitStatusInvalidation } from "../git/Layers/RemoteGitStatusInvalidation.ts";
import { makeGitStatusRefresh } from "../git/gitStatusRefresh.ts";
import { Keybindings } from "../keybindings/keybindings";
import { Open, resolveAvailableEditors, resolveAvailableTerminals } from "../utils/open";
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
import { toDispatchCommandError } from "./wsDispatchCommandError.ts";
import { WorkspaceEntries } from "../workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "../workspace/Services/WorkspaceFileSystem";
import { WorkspaceRuntime } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { RemoteAgentShellRunner } from "../remote-agent/remoteAgentShell.ts";
import {
  isRemoteAgentConfigured,
  RemoteAgentHealthService,
  RemoteAgentInstallerService,
} from "../remote-agent/remoteAgentServerLayer.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner";
import { makeBootstrapWorktreeIdentityResolver } from "./wsBootstrap.identity.ts";
import type { BootstrapCommandLock } from "./wsBootstrap.lock.ts";
import { resolveTextGenByProbeStatus } from "./wsSettingsResolver";
import { makeDispatchShellCommand } from "./wsShellDispatch";
import { formatRemoteExecutionTargetDetail, isLocalExecutionTarget } from "../executionTargets";
import { ProjectionNoteRepository } from "../persistence/Services/ProjectionNotes";
import { ProjectionKanbanRepository } from "../persistence/Services/ProjectionKanban.ts";
import { AutomationScheduleRepository } from "../persistence/Services/AutomationScheduleRepository.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { OrchestrationBootstrapRecipeRepository } from "../persistence/Services/OrchestrationBootstrapRecipes.ts";
import { SchedulerReactor } from "../orchestration/Services/SchedulerReactor.ts";
import { MobileRemoteControl } from "../mobile/Services/MobileRemoteControl.ts";
import { makeServerHandoffJobs } from "./wsHandoffJobs.ts";
import { ThreadRetention } from "../retention/Services/ThreadRetention.ts";
import { PluginRegistry, type PluginRegistryShape } from "../plugins/Services/PluginRegistry";
import { makeCoalescedPromiseEffect, toError } from "./wsRpcContext.helpers";
import { DesktopSupervisorDelivery } from "../desktop-supervisor/desktopSupervisorDelivery.ts";
import { CommandGateway } from "../command-gateway/Services/CommandGateway.ts";
import { makeWsRpcCommandDispatch } from "./wsRpcContext.commandDispatch.ts";

export { makeCoalescedPromiseEffect } from "./wsRpcContext.helpers";

export const makeWsRpcContext = (withBootstrapCommandLock: BootstrapCommandLock) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const projectionCatalogQuery = yield* ProjectionCatalogQuery;
    const projectionOperationalStateQuery = yield* Effect.serviceOption(
      ProjectionOperationalStateQuery,
    );
    const orchestrationEngine = yield* OrchestrationEngineService;
    const commandGateway = yield* CommandGateway;
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const keybindings = yield* Keybindings;
    const open = yield* Open;
    const gitManager = yield* GitManager;
    const git = yield* GitCore;
    const gitStatusBroadcaster = yield* GitStatusBroadcaster;
    const remoteGitStatusInvalidation = yield* makeRemoteGitStatusInvalidation;
    const terminalManager = yield* TerminalManager;
    const providerService = yield* ProviderService;
    const providerRegistry = yield* ProviderRegistry;
    const discoveryRegistry = yield* DiscoveryRegistry;
    const threadShellRunner = yield* ThreadShellRunner;
    const remoteAgentShellRunner = yield* Effect.serviceOption(RemoteAgentShellRunner);
    const remoteAgentHealth = yield* Effect.serviceOption(RemoteAgentHealthService);
    const remoteAgentInstaller = yield* Effect.serviceOption(RemoteAgentInstallerService);
    const config = yield* ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const serverSettings = yield* ServerSettingsService;
    const cliProxyLifecycleOption = yield* Effect.serviceOption(CliProxyLifecycle);
    const startup = yield* ServerRuntimeStartup;
    const workspaceEntries = yield* WorkspaceEntries;
    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const workspaceRuntime = yield* WorkspaceRuntime;
    const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
    const projectionNotes = yield* ProjectionNoteRepository;
    const projectionKanban = yield* ProjectionKanbanRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const bootstrapRecipes = yield* OrchestrationBootstrapRecipeRepository;
    const automationScheduleRepository = yield* AutomationScheduleRepository;
    const schedulerReactor = yield* SchedulerReactor;
    const mobileRemoteControl = yield* MobileRemoteControl;
    const desktopSupervisorDelivery = yield* DesktopSupervisorDelivery;
    const fileSystem = yield* FileSystem.FileSystem;
    const resolveBootstrapWorktreeIdentity = yield* makeBootstrapWorktreeIdentityResolver;
    const handoffJobs = yield* makeServerHandoffJobs;
    const threadRetentionOption = yield* Effect.serviceOption(ThreadRetention);
    const pluginRegistryOption = yield* Effect.serviceOption(PluginRegistry);
    const pluginRegistry: PluginRegistryShape = Option.getOrElse(pluginRegistryOption, () => ({
      listCatalog: Effect.succeed({
        revision: "unavailable",
        sync: { status: "unavailable" as const },
        items: [],
        installed: [],
      }),
      get: () => Effect.die("Plugin registry is unavailable"),
      refresh: Effect.succeed({
        revision: "unavailable",
        sync: { status: "unavailable" as const },
        items: [],
        installed: [],
      }),
      install: () => Effect.die("Plugin registry is unavailable"),
      update: () => Effect.die("Plugin registry is unavailable"),
      uninstall: () => Effect.die("Plugin registry is unavailable"),
      streamChanges: Stream.empty,
      // @effect-diagnostics-next-line effectSucceedWithVoid:off
      resolveAsset: () => Effect.succeed(undefined),
      getInstalledSkillRoots: Effect.succeed([]),
    }));
    const retentionUnavailable = () =>
      Effect.fail(
        new ServerThreadRetentionError({
          code: "disabled",
          message: "Thread retention is unavailable in this server runtime.",
        }),
      );
    const threadRetention = Option.getOrElse(threadRetentionOption, () => ({
      preview: retentionUnavailable,
      enqueue: retentionUnavailable,
      setPolicy: retentionUnavailable,
      runScheduledOnce: retentionUnavailable(),
      start: Effect.void,
    }));

    const refreshGitStatus = makeGitStatusRefresh({
      gitManager,
      gitStatusBroadcaster,
      remoteGitStatusInvalidation,
    });

    const gitStatus = (input: Parameters<GitManagerShape["status"]>[0]) =>
      isLocalExecutionTarget(input.executionTargetId)
        ? gitManager.status(input)
        : git.status(input);

    const commandDispatch = makeWsRpcCommandDispatch({
      orchestrationEngine,
      commandGateway,
      startup,
      git,
      projectSetupScriptRunner,
      refreshGitStatus,
      withBootstrapCommandLock,
      resolveBootstrapWorktreeIdentity,
      bootstrapRecipes,
    });

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

    const dispatchShellCommand = makeDispatchShellCommand({
      enqueueCommand: (effect) => startup.enqueueCommand(effect),
      dispatchInitialShellCommand: commandDispatch.dispatchInitialShellCommand,
      orchestrationEngine,
      serverSettings,
      threadShellRunner,
      ...(Option.isSome(remoteAgentShellRunner)
        ? { remoteThreadShellRunner: remoteAgentShellRunner.value.resolve }
        : {}),
      serverCommandId: commandDispatch.serverCommandId,
      toDispatchCommandError,
    });

    const activateCliProxy = makeCoalescedPromiseEffect(() =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        if (Option.isNone(cliProxyLifecycleOption)) {
          return yield* Effect.fail(
            new Error("CLIProxyAPI is not available in this server build."),
          );
        }
        yield* Effect.tryPromise({
          try: () =>
            activateCliProxyRuntime({ settings, lifecycle: cliProxyLifecycleOption.value }),
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
      const remoteAgentEnabled = isRemoteAgentConfigured();

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
        availableTerminals: resolveAvailableTerminals(),
        observability: {
          logsDirectoryPath: config.logsDir,
          localTracingEnabled: true,
          ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
          otlpTracesEnabled: config.otlpTracesUrl !== undefined,
          ...(config.otlpMetricsUrl !== undefined ? { otlpMetricsUrl: config.otlpMetricsUrl } : {}),
          otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
        },
        workspaceCapabilities: {
          remoteAgent: {
            enabled: remoteAgentEnabled,
            supportsDirectoryWatch: true,
            supportsPtyReattach: remoteAgentEnabled,
          },
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
      dispatchNormalizedCommand: commandDispatch.dispatchNormalizedCommand,
      dispatchShellCommand,
      discoveryRegistry,
      desktopSupervisorDelivery,
      fileSystem,
      git,
      gitManager,
      gitStatus,
      gitStatusBroadcaster,
      handoffJobs,
      keybindings,
      lifecycleEvents,
      loadServerConfig,
      mobileRemoteControl,
      normalizeDispatchCommand,
      open,
      orchestrationEngine,
      pluginRegistry,
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
      remoteGitStatusInvalidation,
      schedulerReactor,
      serverCommandId: commandDispatch.serverCommandId,
      serverSettings,
      startup,
      terminalManager,
      threadShellRunner,
      threadRetention,
      toDispatchCommandError,
      workspaceEntries,
      workspaceFileSystem,
      workspaceRuntime,
      remoteAgentHealth: Option.getOrUndefined(remoteAgentHealth),
      remoteAgentInstaller: Option.getOrUndefined(remoteAgentInstaller),
    };
  });

export type WsRpcContext =
  ReturnType<typeof makeWsRpcContext> extends Effect.Effect<infer A, any, any> ? A : never;
