import { type PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  LOCAL_EXECUTION_TARGET_ID,
  type ProviderApprovalDecision,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
} from "@bigbud/contracts";
import { Cause, Effect, Queue, Random, Ref, Stream } from "effect";

import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { isRemoteWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../../Errors.ts";
import { getProviderCapabilities } from "../../providerCapabilities.ts";
import { resolveProviderExecutionContext } from "../../providerExecutionContext.ts";
import type {
  ClaudeSessionContext,
  PendingApproval,
  PendingUserInput,
  PromptQueueItem,
} from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { makeApprovalHandlers } from "./Adapter.approval.ts";
import { createClaudeRemoteWorkspaceBridge } from "./ClaudeRemoteWorkspaceBridge.ts";
import {
  buildClaudeSessionOrchestrationConfig,
  composeBridgeCleanups,
  prepareThreadOrchestrationMcpBridge,
} from "../../../orchestration-tools/orchestrationMcpBridge.session.ts";
import { emitSessionRuntimeEvents, startSessionRuntimeStream } from "./Adapter.session.runtime.ts";
import { readClaudeResumeState, toMessage, validateClaudeResumeBoundary } from "./Adapter.utils.ts";
import { buildClaudeQueryOptions } from "./Adapter.session.options.ts";
import { makeClaudeTaskState } from "./Adapter.tasks.ts";
import type { ClaudeRequestLedger } from "./Adapter.requestLedger.ts";
import { makeLogNativeSdkMessage } from "./Adapter.session.log.ts";
import { initializeClaudeMcpLifecycle } from "./Adapter.session.mcp.ts";
import type { SessionStartDeps } from "./Adapter.session.types.ts";
import { deleteClaudeSessionIfCurrent } from "./Adapter.events.ts";

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
    sessions,
  });

  return Effect.fn("startSession")(function* (input: ProviderSessionStartInput) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }

    const harness = deps.resolveHarness ? yield* deps.resolveHarness(input) : deps.harness;
    const startedAt = yield* nowIso;
    const sessionEpoch = input.sessionEpoch ?? 0;
    const resumeStateData = readClaudeResumeState(input.resumeCursor);
    const persistedResumeBoundary =
      input.resumeCursor && typeof input.resumeCursor === "object"
        ? (input.resumeCursor as { readonly resumeSessionAt?: unknown }).resumeSessionAt
        : undefined;
    const validResumeState =
      persistedResumeBoundary !== undefined &&
      (typeof persistedResumeBoundary !== "string" ||
        !validateClaudeResumeBoundary({ resumeSessionAt: persistedResumeBoundary }).ok)
        ? undefined
        : resumeStateData;
    const existingResumeSessionId = validResumeState?.resume;

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
    const claudeBinaryPath = harness?.binaryPath ?? claudeSettings.binaryPath;
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
    const remoteWorkspaceBridge =
      isLocalProviderRuntimeTarget(executionContext.providerRuntimeTarget) &&
      isRemoteWorkspaceTarget(executionContext.workspaceTarget)
        ? yield* Effect.tryPromise({
            try: () =>
              createClaudeRemoteWorkspaceBridge(
                executionContext.workspaceTarget,
                orchestrationBridge.httpConfig,
                deps.remoteWorkspaceReadinessProbe,
              ),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toMessage(cause, "Failed to prepare Claude remote workspace bridge."),
                cause,
              }),
          }).pipe(
            Effect.tapError(() =>
              Effect.promise(() => orchestrationBridge.cleanup()).pipe(Effect.ignore),
            ),
          )
        : undefined;
    const orchestrationConfig = buildClaudeSessionOrchestrationConfig(orchestrationBridge);
    const cleanupBridge = composeBridgeCleanups(
      remoteWorkspaceBridge?.cleanup,
      orchestrationBridge.cleanup,
    );
    const modelSelection =
      input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
    const runtimeCwd = remoteWorkspaceBridge?.cwd ?? input.cwd;
    const {
      apiModelId,
      effectiveEffort,
      fastMode,
      thinking,
      ultracode,
      permissionMode,
      queryOptions,
    } = buildClaudeQueryOptions({
      input,
      claudeBinaryPath,
      orchestrationConfig,
      runtimeCwd,
      remoteQueryOptions: remoteWorkspaceBridge?.queryOptions,
      hasRemoteWorkspaceBridge: remoteWorkspaceBridge !== undefined,
      existingResumeSessionId,
      resumeSessionAt: validResumeState?.resumeSessionAt,
      newSessionId,
      canUseTool,
      onElicitation,
      boundedHookProgress:
        harness?.boundedHookProgress ??
        (harness ? false : claudeSettings.rollout.boundedHookProgress),
      forwardSubagentText:
        harness?.forwardSubagentText ??
        (harness ? false : claudeSettings.rollout.forwardedSubagentText),
      ...(harness?.settingSources ? { settingSources: harness.settingSources } : {}),
      ...(harness?.environment ? { environment: harness.environment } : {}),
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
      sessionEpoch,
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
        ...(validResumeState?.resumeSessionAt
          ? { resumeSessionAt: validResumeState.resumeSessionAt }
          : {}),
        turnCount: validResumeState?.turnCount ?? 0,
      },
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    const context: ClaudeSessionContext = {
      session,
      sessionEpoch,
      promptQueue,
      query: queryRuntime,
      ...(cleanupBridge ? { cleanupRemoteWorkspaceBridge: cleanupBridge } : {}),
      streamFiber: undefined,
      startedAt,
      basePermissionMode: permissionMode,
      effectivePermissionMode: permissionMode,
      currentApiModelId: apiModelId,
      currentEffort: effectiveEffort ?? undefined,
      currentFastMode: fastMode,
      currentThinking: thinking,
      currentUltracode: ultracode,
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
      lastAssistantUuid: validResumeState?.resumeSessionAt,
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
      recoveryAttempts: 0,
      stopped: false,
    };
    yield* Ref.set(contextRef, context);
    sessions.set(threadId, context);

    const cleanupRegisteredSession = Effect.sync(() => {
      deleteClaudeSessionIfCurrent(sessions, context);
      try {
        queryRuntime.close();
      } catch {
        // Preserve the startup error; shutdown is best effort here.
      }
      void cleanupBridge().catch(() => undefined);
    }).pipe(Effect.tap(() => Ref.set(contextRef, undefined)));

    yield* startRuntimeStream({ context, logNativeSdkMessage, runFork }).pipe(
      Effect.tapError(() => cleanupRegisteredSession),
    );

    yield* initializeClaudeMcpLifecycle({ context, query: queryRuntime, threadId }).pipe(
      Effect.tapError(() => cleanupRegisteredSession),
    );

    yield* emitRuntimeEvents({
      context,
      threadId,
      resumeCursor: input.resumeCursor,
      apiModelId,
      cwd: input.cwd,
      effectiveEffort: effectiveEffort ?? undefined,
      permissionMode,
      dangerousPermissionBypass: permissionMode === "bypassPermissions",
      fastMode,
    }).pipe(Effect.tapError(() => cleanupRegisteredSession));

    return {
      ...session,
    };
  });
};
