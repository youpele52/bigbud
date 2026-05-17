import {
  LOCAL_EXECUTION_TARGET_ID,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import {
  CopilotClient,
  type CopilotClientOptions,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import { Effect } from "effect";

import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { isRemoteWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../../Errors.ts";
import { getProviderCapabilities } from "../../providerCapabilities.ts";
import { resolveProviderExecutionContext } from "../../providerExecutionContext.ts";
import { type CopilotAdapterShape } from "../../Services/Copilot/Adapter.ts";
import { createCopilotRemoteWorkspaceBridge } from "./CopilotRemoteWorkspaceBridge.ts";
import {
  DEFAULT_BINARY_PATH,
  PROVIDER,
  type ActiveCopilotSession,
  type CopilotAdapterLiveOptions,
  type PendingApprovalRequest,
  type PendingUserInputRequest,
  makeNodeWrapperCliPath,
  toMessage,
} from "./Adapter.types.ts";

export interface SessionOpsDeps {
  readonly sessions: Map<ThreadId, ActiveCopilotSession>;
  readonly serverConfig: { readonly attachmentsDir: string };
  readonly serverSettings: {
    readonly getSettings: Effect.Effect<
      {
        readonly providers: {
          readonly copilot: { readonly binaryPath: string };
        };
      },
      Error
    >;
  };
  readonly options: CopilotAdapterLiveOptions | undefined;
  readonly emit: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;
  // biome-ignore lint/suspicious/noExplicitAny: wide type used intentionally to avoid generic function assignment errors
  readonly makeSyntheticEvent: (
    threadId: ThreadId,
    type: string,
    payload: any,
    extra?: { turnId?: TurnId; itemId?: string; requestId?: string },
  ) => Effect.Effect<ProviderRuntimeEvent>;
  readonly buildSessionConfig: (
    input: {
      threadId: ThreadId;
      runtimeMode: ProviderSession["runtimeMode"];
      cwd?: string;
      modelSelection?: ProviderSendTurnInput["modelSelection"] | ProviderSession["resumeCursor"];
      sessionConfigOverrides?: Partial<SessionConfig>;
    },
    pendingApprovals: Map<string, PendingApprovalRequest>,
    pendingUserInputs: Map<string, PendingUserInputRequest>,
    activeTurnId: () => TurnId | undefined,
    stoppedRef: { stopped: boolean },
  ) => SessionConfig;
  readonly handleEvent: (session: ActiveCopilotSession, event: SessionEvent) => Effect.Effect<void>;
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ActiveCopilotSession, ProviderAdapterSessionNotFoundError>;
}

export const makeStartSession =
  (deps: SessionOpsDeps): CopilotAdapterShape["startSession"] =>
  (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = deps.sessions.get(input.threadId);
      if (existing) {
        return {
          provider: PROVIDER,
          status: existing.activeTurnId ? "running" : "ready",
          runtimeMode: existing.runtimeMode,
          threadId: input.threadId,
          ...(existing.providerRuntimeExecutionTargetId
            ? { providerRuntimeExecutionTargetId: existing.providerRuntimeExecutionTargetId }
            : {}),
          ...(existing.workspaceExecutionTargetId
            ? { workspaceExecutionTargetId: existing.workspaceExecutionTargetId }
            : {}),
          ...(existing.cwd ? { cwd: existing.cwd } : {}),
          ...(existing.model ? { model: existing.model } : {}),
          resumeCursor: { sessionId: existing.session.sessionId },
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          ...(existing.lastError ? { lastError: existing.lastError } : {}),
        } satisfies ProviderSession;
      }

      const copilotSettings = yield* deps.serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      );
      const useCustomBinary = copilotSettings.binaryPath !== DEFAULT_BINARY_PATH;
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
              try: () => createCopilotRemoteWorkspaceBridge(executionContext.workspaceTarget),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: toMessage(
                    cause,
                    "Failed to prepare GitHub Copilot remote workspace bridge.",
                  ),
                  cause,
                }),
            })
          : undefined;
      const resolvedCliPath = useCustomBinary
        ? copilotSettings.binaryPath
        : makeNodeWrapperCliPath();
      const runtimeCwd = remoteWorkspaceBridge?.runtimeCwd ?? input.cwd;
      const sessionWorkingDirectory =
        remoteWorkspaceBridge?.clientSessionFsConfig.initialCwd ?? input.cwd;
      const clientOptions: CopilotClientOptions = {
        ...(resolvedCliPath !== undefined ? { cliPath: resolvedCliPath } : {}),
        ...(runtimeCwd ? { cwd: runtimeCwd } : {}),
        ...(remoteWorkspaceBridge?.clientSessionFsConfig
          ? { sessionFs: remoteWorkspaceBridge.clientSessionFsConfig }
          : {}),
        logLevel: "error",
      };
      const client =
        deps.options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions);
      const pendingApprovals = new Map<string, PendingApprovalRequest>();
      const pendingUserInputs = new Map<string, PendingUserInputRequest>();
      let activeTurn: TurnId | undefined;
      const stoppedRef = { stopped: false };
      const sessionConfig = deps.buildSessionConfig(
        {
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          ...(sessionWorkingDirectory ? { cwd: sessionWorkingDirectory } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(remoteWorkspaceBridge?.sessionConfig
            ? { sessionConfigOverrides: remoteWorkspaceBridge.sessionConfig }
            : {}),
        },
        pendingApprovals,
        pendingUserInputs,
        () => activeTurn,
        stoppedRef,
      );

      const session = yield* Effect.tryPromise({
        try: () => {
          const sessionId =
            typeof input.resumeCursor === "object" &&
            input.resumeCursor !== null &&
            "sessionId" in input.resumeCursor &&
            typeof input.resumeCursor.sessionId === "string"
              ? input.resumeCursor.sessionId
              : undefined;
          return sessionId
            ? client.resumeSession(sessionId, sessionConfig as ResumeSessionConfig)
            : client.createSession(sessionConfig);
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start GitHub Copilot session."),
            cause,
          }),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            void remoteWorkspaceBridge?.cleanup().catch(() => undefined);
          }),
        ),
      );

      const createdAt = new Date().toISOString();
      const record: ActiveCopilotSession = {
        client,
        session,
        threadId: input.threadId,
        createdAt,
        runtimeMode: input.runtimeMode,
        providerRuntimeExecutionTargetId:
          executionContext.executionTargets.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: executionContext.executionTargets.workspaceExecutionTargetId,
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        renewSession: () => client.createSession(sessionConfig),
        ...(remoteWorkspaceBridge?.cleanup
          ? { cleanupRemoteWorkspaceBridge: remoteWorkspaceBridge.cleanup }
          : {}),
        unsubscribe: () => {},
        cwd: input.cwd,
        model:
          input.modelSelection?.provider === "copilot" ? input.modelSelection.model : undefined,
        updatedAt: createdAt,
        lastError: undefined,
        activeTurnId: undefined,
        activeMessageId: undefined,
        lastUsage: undefined,
        get stopped() {
          return stoppedRef.stopped;
        },
        set stopped(value: boolean) {
          stoppedRef.stopped = value;
        },
      };

      record.unsubscribe = session.on((event) => {
        activeTurn =
          event.type === "assistant.turn_start" ? TurnId.makeUnsafe(event.data.turnId) : activeTurn;
        void deps
          .handleEvent(record, event)
          .pipe(Effect.runPromise)
          .catch(() => undefined);
        activeTurn = record.activeTurnId;
      });

      deps.sessions.set(input.threadId, record);

      yield* deps.emit([
        yield* deps.makeSyntheticEvent(
          input.threadId,
          "session.started",
          input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        ),
        yield* deps.makeSyntheticEvent(input.threadId, "thread.started", {
          providerThreadId: session.sessionId,
        }),
        yield* deps.makeSyntheticEvent(input.threadId, "session.state.changed", {
          state: "ready",
          reason: "session.started",
        }),
      ]);

      return {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
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
        ...(record.model ? { model: record.model } : {}),
        resumeCursor: { sessionId: session.sessionId },
        createdAt,
        updatedAt: createdAt,
      } satisfies ProviderSession;
    });
