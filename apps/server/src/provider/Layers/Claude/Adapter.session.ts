/**
 * ClaudeAdapter session startup helpers.
 *
 * Contains `logNativeSdkMessage`, `buildUserMessageEffect`, and `startSession` —
 * the session initialization logic extracted from the main adapter module.
 *
 * @module ClaudeAdapter.session
 */
import {
  type Options as ClaudeQueryOptions,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  LOCAL_EXECUTION_TARGET_ID,
  type EventId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  ThreadId,
  ClaudeCodeEffort,
} from "@bigbud/contracts";
import { resolveApiModelId, resolveEffort } from "@bigbud/shared/model";
import { Cause, Effect, FileSystem, Queue, Random, Ref, Stream } from "effect";

import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { isRemoteWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { getClaudeModelCapabilities } from "./Provider.ts";
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
import {
  asCanonicalTurnId,
  getEffectiveClaudeCodeEffort,
  readClaudeResumeState,
  sdkNativeItemId,
  sdkNativeMethod,
  toMessage,
  CLAUDE_SETTING_SOURCES,
} from "./Adapter.utils.ts";
import { resolveBasePermissionMode } from "./Adapter.session.permissions.ts";

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
      { readonly providers: { readonly claudeAgent: { readonly binaryPath: string } } },
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

/** Log a raw SDK message to the native event log if enabled. */
export const makeLogNativeSdkMessage = (deps: Pick<SessionStartDeps, "nativeEventLogger">) => {
  const { nativeEventLogger } = deps;
  return Effect.fn("logNativeSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    const observedAt = new Date().toISOString();
    const itemId = sdkNativeItemId(message);

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : crypto.randomUUID(),
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          ...(itemId
            ? {
                itemId: ProviderItemId.makeUnsafe(itemId),
              }
            : {}),
          payload: message,
        },
      },
      context.session.threadId,
    );
  });
};

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

  const logNativeSdkMessage = makeLogNativeSdkMessage(deps);
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

    const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

    const { canUseTool } = makeApprovalHandlers({
      makeEventStamp,
      offerRuntimeEvent,
      runFork,
      runPromise,
      emitProposedPlanCompleted: streamHandlers.emitProposedPlanCompleted,
      contextRef,
      pendingApprovals,
      pendingUserInputs,
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
    const caps = getClaudeModelCapabilities(modelSelection?.model);
    const apiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
    const effort = (resolveEffort(caps, modelSelection?.options?.effort) ??
      null) as ClaudeCodeEffort | null;
    const fastMode = modelSelection?.options?.fastMode === true && caps.supportsFastMode;
    const thinking =
      typeof modelSelection?.options?.thinking === "boolean" && caps.supportsThinkingToggle
        ? modelSelection.options.thinking
        : undefined;
    const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
    const permissionMode = resolveBasePermissionMode(input.runtimeMode);
    const settings = {
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
    };
    const runtimeCwd = remoteWorkspaceBridge?.cwd ?? input.cwd;

    const remoteQueryOptions = remoteWorkspaceBridge?.queryOptions;
    const queryOptions = {
      ...(runtimeCwd ? { cwd: runtimeCwd } : {}),
      ...(apiModelId ? { model: apiModelId } : {}),
      pathToClaudeCodeExecutable: claudeBinaryPath,
      settingSources: [...CLAUDE_SETTING_SOURCES],
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
      ...(newSessionId ? { sessionId: newSessionId } : {}),
      ...remoteQueryOptions,
      mcpServers: {
        ...remoteQueryOptions?.mcpServers,
        ...orchestrationConfig.mcpServers,
      },
      allowedTools: [
        ...(remoteQueryOptions?.allowedTools ?? []),
        ...orchestrationConfig.allowedTools,
      ],
      includePartialMessages: true,
      canUseTool,
      env: process.env,
      ...(runtimeCwd && !remoteWorkspaceBridge ? { additionalDirectories: [runtimeCwd] } : {}),
    } as ClaudeQueryOptions;

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
      currentApiModelId: apiModelId,
      resumeSessionId: sessionId,
      pendingApprovals,
      pendingUserInputs,
      turns: [],
      inFlightTools: new Map(),
      turnState: undefined,
      lastKnownContextWindow: undefined,
      lastKnownTokenUsage: undefined,
      lastAssistantUuid: resumeStateData?.resumeSessionAt,
      lastThreadStartedId: undefined,
      stopped: false,
    };
    yield* Ref.set(contextRef, context);
    sessions.set(threadId, context);

    yield* emitRuntimeEvents({
      threadId,
      resumeCursor: input.resumeCursor,
      apiModelId,
      cwd: input.cwd,
      effectiveEffort: effectiveEffort ?? undefined,
      permissionMode,
      fastMode,
    });

    yield* startRuntimeStream({ context, logNativeSdkMessage, runFork });

    return {
      ...session,
    };
  });
};
