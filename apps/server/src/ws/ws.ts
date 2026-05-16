import { Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  ThreadId,
  type TerminalEvent,
  WS_METHODS,
  WsRpcGroup,
  GitCommandError,
} from "@bigbud/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

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
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "../observability/RpcInstrumentation";
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
import { WorkspacePathOutsideRootError } from "../workspace/Services/WorkspacePaths";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner";
import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap";
import {
  makeOrderedOrchestrationDomainEventStream,
  makeServerConfigUpdateStream,
  makeThinkingActivityDeltaStream,
} from "./wsStreams";
import { resolveTextGenByProbeStatus } from "./wsSettingsResolver";
import { makeDispatchShellCommand } from "./wsShellDispatch";
import { formatRemoteExecutionTargetDetail, isLocalExecutionTarget } from "../executionTargets";
import {
  unlockSshKeyEffect,
  unlockSshPasswordEffect,
  verifyExecutionTargetEffect,
} from "./wsExecutionTargetVerification.ts";

const WsRpcLayer = WsRpcGroup.toLayer(
  Effect.gen(function* () {
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

    const refreshGitStatusEffect = (cwd: string) =>
      gitManager.invalidateStatus(cwd).pipe(
        Effect.flatMap(() => gitStatusBroadcaster.invalidateLocal(cwd)),
        Effect.flatMap(() => gitStatusBroadcaster.invalidateRemote(cwd)),
      );

    const dispatchBootstrapThreadCommand = makeDispatchBootstrapThreadCommand(
      orchestrationEngine,
      git,
      projectSetupScriptRunner,
      refreshGitStatusEffect,
      appendSetupScriptActivity,
      serverCommandId,
    );

    const refreshGitStatus = (cwd: string) =>
      gitManager.invalidateStatus(cwd).pipe(
        Effect.flatMap(() => gitStatusBroadcaster.invalidateLocal(cwd)),
        Effect.flatMap(() => gitStatusBroadcaster.invalidateRemote(cwd)),
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

    return WsRpcGroup.of({
      [ORCHESTRATION_WS_METHODS.getSnapshot]: (_input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getSnapshot,
          projectionSnapshotQuery.getSnapshot().pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to load orchestration snapshot",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.dispatchCommand,
          Effect.gen(function* () {
            const normalizedCommand = yield* normalizeDispatchCommand(command);
            if (normalizedCommand.type === "thread.shell.run") {
              return yield* dispatchShellCommand(normalizedCommand);
            }
            const result = yield* dispatchNormalizedCommand(normalizedCommand);
            if (normalizedCommand.type === "thread.archive") {
              yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("failed to close thread terminals after archive", {
                    threadId: normalizedCommand.threadId,
                    error: error.message,
                  }),
                ),
              );
            }
            return result;
          }).pipe(
            Effect.mapError((cause) =>
              Schema.is(OrchestrationDispatchCommandError)(cause)
                ? cause
                : new OrchestrationDispatchCommandError({
                    message: "Failed to dispatch orchestration command",
                    cause,
                  }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getTurnDiff,
          checkpointDiffQuery.getTurnDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetTurnDiffError({
                  message: "Failed to load turn diff",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getFullThreadDiff,
          checkpointDiffQuery.getFullThreadDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetFullThreadDiffError({
                  message: "Failed to load full thread diff",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.replayEvents,
          Stream.runCollect(
            orchestrationEngine.readEvents(
              clamp(input.fromSequenceExclusive, { maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
            ),
          ).pipe(
            Effect.map((events) => Array.from(events)),
            Effect.mapError(
              (cause) =>
                new OrchestrationReplayEventsError({
                  message: "Failed to replay orchestration events",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [WS_METHODS.subscribeOrchestrationDomainEvents]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeOrchestrationDomainEvents,
          makeOrderedOrchestrationDomainEventStream({ orchestrationEngine }),
          { "rpc.aggregate": "orchestration" },
        ),
      [WS_METHODS.subscribeThinkingActivityDeltas]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeThinkingActivityDeltas,
          makeThinkingActivityDeltaStream({ providerService, serverSettings }),
          { "rpc.aggregate": "orchestration" },
        ),
      [WS_METHODS.serverGetConfig]: (_input) =>
        observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.serverRefreshProviders]: (_input) =>
        observeRpcEffect(
          WS_METHODS.serverRefreshProviders,
          providerRegistry.refresh().pipe(Effect.map((providers) => ({ providers }))),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.serverVerifyExecutionTarget]: (input) =>
        observeRpcEffect(
          WS_METHODS.serverVerifyExecutionTarget,
          verifyExecutionTargetEffect(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.serverUnlockSshKey]: (input) =>
        observeRpcEffect(WS_METHODS.serverUnlockSshKey, unlockSshKeyEffect(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.serverUnlockSshPassword]: (input) =>
        observeRpcEffect(WS_METHODS.serverUnlockSshPassword, unlockSshPasswordEffect(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.serverUpsertKeybinding]: (rule) =>
        observeRpcEffect(
          WS_METHODS.serverUpsertKeybinding,
          Effect.gen(function* () {
            const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.serverGetSettings]: (_input) =>
        observeRpcEffect(
          WS_METHODS.serverGetSettings,
          Effect.gen(function* () {
            const providers = yield* providerRegistry.getProviders;
            const rawSettings = yield* serverSettings.getSettings;
            return resolveTextGenByProbeStatus(rawSettings, providers);
          }),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
        observeRpcEffect(WS_METHODS.serverUpdateSettings, serverSettings.updateSettings(patch), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.projectsSearchEntries]: (input) =>
        observeRpcEffect(
          WS_METHODS.projectsSearchEntries,
          workspaceEntries.search(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchEntriesError({
                  message: `Failed to search workspace entries: ${cause.detail}`,
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.projectsWriteFile]: (input) =>
        observeRpcEffect(
          WS_METHODS.projectsWriteFile,
          workspaceFileSystem.writeFile(input).pipe(
            Effect.mapError((cause) => {
              const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                ? "Workspace file path must stay within the project root."
                : "Failed to write workspace file";
              return new ProjectWriteFileError({ message, cause });
            }),
          ),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.shellOpenInEditor]: (input) =>
        observeRpcEffect(WS_METHODS.shellOpenInEditor, open.openInEditor(input), {
          "rpc.aggregate": "workspace",
        }),
      [WS_METHODS.subscribeGitStatus]: (input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeGitStatus,
          assertLocalGitExecutionTarget(
            input.cwd,
            input.executionTargetId,
            "git.subscribeStatus",
          ).pipe(Effect.andThen(gitStatusBroadcaster.subscribe(input.cwd))),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.gitRefreshStatus]: (input) =>
        observeRpcEffect(WS_METHODS.gitRefreshStatus, gitManager.status(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitPull]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitPull,
          assertLocalGitExecutionTarget(input.cwd, input.executionTargetId, "git.pull").pipe(
            Effect.andThen(git.pullCurrentBranch(input.cwd)),
            Effect.tap(() => refreshGitStatus(input.cwd)),
          ),
          {
            "rpc.aggregate": "git",
          },
        ),
      [WS_METHODS.gitRunStackedAction]: (input) =>
        observeRpcStream(
          WS_METHODS.gitRunStackedAction,
          Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
            gitManager
              .runStackedAction(input, {
                actionId: input.actionId,
                progressReporter: {
                  publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                },
              })
              .pipe(
                Effect.tap(() => refreshGitStatus(input.cwd)),
                Effect.matchCauseEffect({
                  onFailure: (cause) => Queue.failCause(queue, cause),
                  onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
                }),
              ),
          ),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.gitResolvePullRequest]: (input) =>
        observeRpcEffect(WS_METHODS.gitResolvePullRequest, gitManager.resolvePullRequest(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitPreparePullRequestThread]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitPreparePullRequestThread,
          gitManager
            .preparePullRequestThread(input)
            .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.gitListBranches]: (input) =>
        observeRpcEffect(WS_METHODS.gitListBranches, git.listBranches(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitCreateWorktree]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitCreateWorktree,
          git.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
          {
            "rpc.aggregate": "git",
          },
        ),
      [WS_METHODS.gitRemoveWorktree]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitRemoveWorktree,
          git.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
          {
            "rpc.aggregate": "git",
          },
        ),
      [WS_METHODS.gitCreateBranch]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitCreateBranch,
          git.createBranch(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
          {
            "rpc.aggregate": "git",
          },
        ),
      [WS_METHODS.gitCheckout]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitCheckout,
          git.checkoutBranch(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
          {
            "rpc.aggregate": "git",
          },
        ),
      [WS_METHODS.gitInit]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitInit,
          git.initRepo(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.terminalOpen]: (input) =>
        observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalWrite]: (input) =>
        observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalResize]: (input) =>
        observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalClear]: (input) =>
        observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalRestart]: (input) =>
        observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalClose]: (input) =>
        observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.subscribeTerminalEvents]: (_input) =>
        observeRpcStream(
          WS_METHODS.subscribeTerminalEvents,
          Stream.callback<TerminalEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribe((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
          { "rpc.aggregate": "terminal" },
        ),
      [WS_METHODS.subscribeServerConfig]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeServerConfig,
          makeServerConfigUpdateStream({
            loadServerConfig,
            keybindings,
            providerRegistry,
            discoveryRegistry,
            serverSettings,
          }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.subscribeServerLifecycle]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeServerLifecycle,
          Effect.gen(function* () {
            const snapshot = yield* lifecycleEvents.snapshot;
            const snapshotEvents = Array.from(snapshot.events).toSorted(
              (left, right) => left.sequence - right.sequence,
            );
            const liveEvents = lifecycleEvents.stream.pipe(
              Stream.filter((event) => event.sequence > snapshot.sequence),
            );
            return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
          }),
          { "rpc.aggregate": "server" },
        ),
    });
  }),
);

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
      spanPrefix: "ws.rpc",
      spanAttributes: {
        "rpc.transport": "websocket",
        "rpc.system": "effect-rpc",
      },
    }).pipe(Effect.provide(Layer.mergeAll(WsRpcLayer, RpcSerialization.layerJson)));
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        if (config.authToken) {
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url)) {
            return HttpServerResponse.text("Invalid WebSocket URL", { status: 400 });
          }
          const token = url.value.searchParams.get("token");
          if (token !== config.authToken) {
            return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
          }
        }
        return yield* rpcWebSocketHttpEffect;
      }),
    );
  }),
);
