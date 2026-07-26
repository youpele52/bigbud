/**
 * ClaudeAdapter session startup helpers.
 * Contains `logNativeSdkMessage`, `buildUserMessageEffect`, and `startSession`.
 *
 * @module ClaudeAdapter.session
 */
import {
  type Options as ClaudeQueryOptions,
  type PermissionUpdate,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  LOCAL_EXECUTION_TARGET_ID,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  ThreadId,
} from "@bigbud/contracts";
import { Cause, Effect, FileSystem, Queue, Random, Ref, Stream } from "effect";

import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { isRemoteWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../../Errors.ts";
import { getProviderCapabilities } from "../../providerCapabilities.ts";
import { resolveProviderExecutionContext } from "../../providerExecutionContext.ts";
import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type {
  ClaudeQueryRuntime,
  ClaudeSessionContext,
  PendingApproval,
  PendingUserInput,
  PromptQueueItem,
} from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { StreamHandlers } from "./Adapter.stream.ts";
import { makeApprovalHandlers } from "./Adapter.approval.ts";
import { createClaudeRemoteWorkspaceBridge } from "./ClaudeRemoteWorkspaceBridge.ts";
import {
  buildClaudeSessionOrchestrationConfig,
  composeBridgeCleanups,
  prepareThreadOrchestrationMcpBridge,
} from "../../../orchestration-tools/orchestrationMcpBridge.session.ts";
import { emitSessionRuntimeEvents, startSessionRuntimeStream } from "./Adapter.session.runtime.ts";
import { readClaudeResumeState, toMessage } from "./Adapter.utils.ts";
import { buildClaudeQueryOptions } from "./Adapter.session.options.ts";
import { makeClaudeTaskState } from "./Adapter.tasks.ts";
import type { ClaudeRequestLedger } from "./Adapter.requestLedger.ts";
import { makeLogNativeSdkMessage } from "./Adapter.session.log.ts";
import { initializeClaudeMcpLifecycle } from "./Adapter.session.mcp.ts";

export interface SessionStartDeps {
  readonly fileSystem: FileSystem.FileSystem;
  readonly serverConfig: {
    readonly attachmentsDir: string;
    readonly stateDir: string;
    readonly port: number;
    readonly host: string | undefined;
  };
  readonly serverSettingsService: {
    readonly getSettings: Effect.Effect<
      {
        readonly providers: {
          readonly claudeAgent: {
            readonly binaryPath: string;
            readonly rollout: {
              readonly modernTaskExposure: boolean;
              readonly boundedHookProgress: boolean;
              readonly forwardedSubagentText: boolean;
              readonly mcpControls: boolean;
            };
          };
        };
      },
      Error
    >;
  };
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly createQuery: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly sessions: Map<ThreadId, ClaudeSessionContext>;
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly nowIso: Effect.Effect<string>;
  readonly streamHandlers: StreamHandlers;
}

/** Initialize a new provider session and start the SDK stream fiber. */
export const makeStartSession = (deps: SessionStartDeps) => {
  const {
    serverSettingsService,
    createQuery,
    sessions,
    makeEventStamp,
    offerRuntimeEvent,
    nowIso,
    streamHandlers,
  } = deps;

  const logNativeSdkMessage = makeLogNativeSdkMessage(deps.nativeEventLogger);
  const emitRuntimeEvents = emitSessionRuntimeEvents({ makeEventStamp, offerRuntimeEvent });
  const startRuntimeStream = startSessionRuntimeStream({
    makeEventStamp,
    offerRuntimeEvent,
    streamHandlers,
  });

  return Effect.fn("startSession")(function* (input: ProviderSessionStartInput) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }

    const startedAt = yield* nowIso;
    const resumeStateData = readClaudeResumeState(input.resumeCursor);
    const existingResumeSessionId = resumeStateData?.resume;

    const threadId = input.threadId;
    const newSessionId =
      existingResumeSessionId === undefined ? yield* Random.nextUUIDv4 : undefined;
    const sessionId = existingResumeSessionId ?? newSessionId;

    const effectServices = yield* Effect.services();
    const runFork = Effect.runForkWith(effectServices);
    const runPromise = Effect.runPromiseWith(effectServices);

    const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
    const prompt = Stream.fromQueue(promptQueue).pipe(
      Stream.filter((item) => item.type === "message"),
      Stream.map((item) => item.message),
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
      ),
      Stream.toAsyncIterable,
    );

    const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
    const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
    const resolvedApprovals = new Map<ApprovalRequestId, ProviderApprovalDecision>();
    const resolvedApprovalSuggestions = new Map<
      ApprovalRequestId,
      ReadonlyArray<PermissionUpdate>
    >();
    const appliedSessionPermissionRequests = new Set<ApprovalRequestId>();
    const resolvedUserInputs = new Map<ApprovalRequestId, ProviderUserInputAnswers>();
    const requestLedger: ClaudeRequestLedger = new Map();

    const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

    const { canUseTool, onElicitation } = makeApprovalHandlers({
      makeEventStamp,
      offerRuntimeEvent,
      runFork,
      runPromise,
      emitProposedPlanCompleted: streamHandlers.emitProposedPlanCompleted,
      contextRef,
      pendingApprovals,
      pendingUserInputs,
      resolvedApprovals,
      resolvedApprovalSuggestions,
      requestLedger,
      runtimeMode: input.runtimeMode,
    });

    const claudeSettings = yield* serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.claudeAgent),
      Effect.mapError(
        (error) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: error.message,
            cause: error,
          }),
      ),
    );
    const claudeBinaryPath = claudeSettings.binaryPath;
    const executionContext = resolveProviderExecutionContext({
      providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId: input.workspaceExecutionTargetId,
      executionTargetId: input.executionTargetId,
      cwd: input.cwd,
      defaultProviderRuntimeExecutionTargetId: getProviderCapabilities(PROVIDER)
        .supportsLocalRuntimeRemoteWorkspace
        ? LOCAL_EXECUTION_TARGET_ID
        : undefined,
      useLegacyExecutionTargetForProviderRuntime: false,
    });
    const remoteWorkspaceBridge =
      isLocalProviderRuntimeTarget(executionContext.providerRuntimeTarget) &&
      isRemoteWorkspaceTarget(executionContext.workspaceTarget)
        ? yield* Effect.tryPromise({
            try: () => createClaudeRemoteWorkspaceBridge(executionContext.workspaceTarget),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toMessage(cause, "Failed to prepare Claude remote workspace bridge."),
                cause,
              }),
          })
        : undefined;
    const orchestrationBridge = yield* Effect.tryPromise({
      try: () =>
        prepareThreadOrchestrationMcpBridge({
          stateDir: deps.serverConfig.stateDir,
          threadId: input.threadId,
          host: deps.serverConfig.host,
          port: deps.serverConfig.port,
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to prepare Claude thread orchestration bridge."),
          cause,
        }),
    });
    const orchestrationConfig = buildClaudeSessionOrchestrationConfig(orchestrationBridge);
    const cleanupBridge = composeBridgeCleanups(
      remoteWorkspaceBridge?.cleanup,
      orchestrationBridge.cleanup,
    );
    const modelSelection =
      input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
    const runtimeCwd = remoteWorkspaceBridge?.cwd ?? input.cwd;
    const { apiModelId, effectiveEffort, fastMode, permissionMode, queryOptions } =
      buildClaudeQueryOptions({
        input,
        claudeBinaryPath,
        orchestrationConfig,
        runtimeCwd,
        remoteQueryOptions: remoteWorkspaceBridge?.queryOptions,
        hasRemoteWorkspaceBridge: remoteWorkspaceBridge !== undefined,
        existingResumeSessionId,
        resumeSessionAt: resumeStateData?.resumeSessionAt,
        newSessionId,
        canUseTool,
        onElicitation,
        boundedHookProgress: claudeSettings.rollout.boundedHookProgress,
        forwardSubagentText: claudeSettings.rollout.forwardedSubagentText,
      });

    const queryRuntime = yield* Effect.try({
      try: () =>
        createQuery({
          prompt,
          options: queryOptions,
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail: toMessage(cause, "Failed to start Claude runtime session."),
          cause,
        }),
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          void cleanupBridge().catch(() => undefined);
        }),
      ),
    );

    const session: ProviderSession = {
      threadId,
      provider: PROVIDER,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(executionContext.executionTargets.providerRuntimeExecutionTargetId
        ? {
            providerRuntimeExecutionTargetId:
              executionContext.executionTargets.providerRuntimeExecutionTargetId,
          }
        : {}),
      ...(executionContext.executionTargets.workspaceExecutionTargetId
        ? {
            workspaceExecutionTargetId:
              executionContext.executionTargets.workspaceExecutionTargetId,
          }
        : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      ...(threadId ? { threadId } : {}),
      resumeCursor: {
        ...(threadId ? { threadId } : {}),
        ...(sessionId ? { resume: sessionId } : {}),
        ...(resumeStateData?.resumeSessionAt
          ? { resumeSessionAt: resumeStateData.resumeSessionAt }
          : {}),
        turnCount: resumeStateData?.turnCount ?? 0,
      },
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    const context: ClaudeSessionContext = {
      session,
      promptQueue,
      query: queryRuntime,
      ...(cleanupBridge ? { cleanupRemoteWorkspaceBridge: cleanupBridge } : {}),
      streamFiber: undefined,
      startedAt,
      basePermissionMode: permissionMode,
      effectivePermissionMode: permissionMode,
      currentApiModelId: apiModelId,
      resumeSessionId: sessionId,
      pendingApprovals,
      pendingUserInputs,
      resolvedApprovals,
      resolvedApprovalSuggestions,
      appliedSessionPermissionRequests,
      resolvedUserInputs,
      requestLedger,
      turns: [],
      inFlightTools: new Map(),
      taskState: makeClaudeTaskState(),
      lastPlanFingerprint: undefined,
      turnState: undefined,
      lastKnownContextWindow: undefined,
      lastKnownTokenUsage: undefined,
      lastAssistantUuid: resumeStateData?.resumeSessionAt,
      lastInterruptReceipt: undefined,
      queuedUserMessageIds: new Set(),
      lastThreadStartedId: undefined,
      seenNativeMessageIds: new Set(),
      mcpStatuses: [],
      requiredMcpServerNames: new Set([
        ...Object.keys(orchestrationConfig.mcpServers),
        ...(remoteWorkspaceBridge ? ["bigbud_remote_workspace"] : []),
      ]),
      modernTaskExposure: claudeSettings.rollout.modernTaskExposure,
      mcpControlsEnabled: claudeSettings.rollout.mcpControls,
      refreshMcpStatuses: undefined,
      recoverStream: undefined,
      recoveryInFlight: undefined,
      stopped: false,
    };
    yield* Ref.set(contextRef, context);
    sessions.set(threadId, context);

    yield* initializeClaudeMcpLifecycle({ context, query: queryRuntime, threadId }).pipe(
      Effect.tapError(() =>
        Ref.set(contextRef, undefined).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              sessions.delete(threadId);
              try {
                queryRuntime.close();
              } catch {
                // Preserve the readiness error; shutdown is best effort here.
              }
              void cleanupBridge().catch(() => undefined);
            }),
          ),
        ),
      ),
    );

    yield* emitRuntimeEvents({
      threadId,
      resumeCursor: input.resumeCursor,
      apiModelId,
      cwd: input.cwd,
      effectiveEffort: effectiveEffort ?? undefined,
      permissionMode,
      dangerousPermissionBypass: permissionMode === "bypassPermissions",
      fastMode,
    });

    yield* startRuntimeStream({ context, logNativeSdkMessage, runFork });

    return {
      ...session,
    };
  });
};
