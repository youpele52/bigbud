import {
  LOCAL_EXECUTION_TARGET_ID,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@bigbud/contracts";
import { type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { Cause, Duration, Effect, type ServiceMap } from "effect";

import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../../Errors.ts";
import type { OpencodeAdapterShape } from "../../Services/Opencode/Adapter.ts";
import type { OpencodeServerManagerShape } from "../../Services/Opencode/ServerManager.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";
import type { SyntheticEventFn } from "./Adapter.stream.primitives.ts";
import {
  buildOpenCodePermissionRules,
  isProviderModelSelection,
  resolveProviderIDForModel,
} from "./Adapter.session.helpers.ts";
import { createOpencodeRemoteWorkspaceBridge } from "./OpencodeRemoteWorkspaceBridge.ts";
import {
  buildOpencodeAllowedTools,
  buildOpencodeThreadOrchestrationServerName,
  composeBridgeCleanups,
  disconnectOpencodeOrchestrationMcpBridge,
  prepareThreadOrchestrationMcpBridge,
  registerOpencodeOrchestrationMcpBridge,
} from "../../../orchestration-tools/orchestrationMcpBridge.session.ts";
import { getProviderCapabilities } from "../../providerCapabilities.ts";
import { resolveProviderExecutionContext } from "../../providerExecutionContext.ts";
import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { isRemoteWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { startEventStream, toMessage } from "./Adapter.stream.ts";

const OPENCODE_ORCHESTRATION_MCP_REGISTRATION_TIMEOUT = Duration.millis(5_500);

export interface StartSessionDeps {
  readonly provider: Extract<ProviderKind, "opencode" | "kilocode">;
  readonly sessions: Map<string, ActiveOpencodeSession>;
  readonly serverManager: OpencodeServerManagerShape;
  readonly serverSettings: Pick<ServerSettingsShape, "getSettings">;
  readonly serverConfig: {
    readonly attachmentsDir: string;
    readonly stateDir: string;
    readonly port: number;
    readonly host: string | undefined;
  };
  readonly emitFn: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;
  readonly handleEventFn: (
    session: ActiveOpencodeSession,
    event: OpencodeEvent,
  ) => Effect.Effect<void>;
  readonly syntheticEventFn: SyntheticEventFn;
  readonly services: ServiceMap.ServiceMap<never>;
}

export function makeStartSession(deps: StartSessionDeps): OpencodeAdapterShape["startSession"] {
  return (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== deps.provider) {
        return yield* new ProviderAdapterValidationError({
          provider: deps.provider,
          operation: "startSession",
          issue: `Expected provider '${deps.provider}' but received '${input.provider}'.`,
        });
      }

      const existing = deps.sessions.get(input.threadId);
      if (existing) {
        return {
          provider: deps.provider,
          status: existing.activeTurnId ? "running" : "ready",
          runtimeMode: existing.runtimeMode,
          ...(existing.providerRuntimeExecutionTargetId
            ? { providerRuntimeExecutionTargetId: existing.providerRuntimeExecutionTargetId }
            : {}),
          ...(existing.workspaceExecutionTargetId
            ? { workspaceExecutionTargetId: existing.workspaceExecutionTargetId }
            : {}),
          threadId: input.threadId,
          ...(existing.executionTargetId ? { executionTargetId: existing.executionTargetId } : {}),
          ...(existing.cwd ? { cwd: existing.cwd } : {}),
          ...(existing.model ? { model: existing.model } : {}),
          resumeCursor: { sessionId: existing.opencodeSessionId },
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          ...(existing.lastError ? { lastError: existing.lastError } : {}),
        } satisfies ProviderSession;
      }

      const settings = yield* deps.serverSettings.getSettings.pipe(
        Effect.map(
          (s) =>
            (s.providers as Record<string, { binaryPath: string } | undefined>)[deps.provider] ?? {
              binaryPath: deps.provider,
            },
        ),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: deps.provider,
              threadId: input.threadId,
              detail: toMessage(cause, `Failed to read ${deps.provider} settings.`),
              cause,
            }),
        ),
      );
      const executionContext = resolveProviderExecutionContext({
        providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: input.workspaceExecutionTargetId,
        executionTargetId: input.executionTargetId,
        cwd: input.cwd,
        defaultProviderRuntimeExecutionTargetId: getProviderCapabilities(deps.provider)
          .supportsLocalRuntimeRemoteWorkspace
          ? LOCAL_EXECUTION_TARGET_ID
          : undefined,
        useLegacyExecutionTargetForProviderRuntime: false,
      });
      const remoteWorkspaceBridge =
        isLocalProviderRuntimeTarget(executionContext.providerRuntimeTarget) &&
        isRemoteWorkspaceTarget(executionContext.workspaceTarget)
          ? yield* Effect.tryPromise({
              try: () => createOpencodeRemoteWorkspaceBridge(executionContext.workspaceTarget),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: deps.provider as Extract<ProviderKind, "opencode" | "kilocode">,
                  threadId: input.threadId,
                  detail: toMessage(
                    cause,
                    `Failed to prepare ${deps.provider} remote workspace bridge.`,
                  ),
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
            serverName: buildOpencodeThreadOrchestrationServerName(input.threadId),
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: deps.provider,
            threadId: input.threadId,
            detail: toMessage(
              cause,
              `Failed to prepare ${deps.provider} orchestration MCP bridge.`,
            ),
            cause,
          }),
      });
      const serverDirectory = remoteWorkspaceBridge?.cwd ?? input.cwd;
      const cleanupBridge = composeBridgeCleanups(
        remoteWorkspaceBridge?.cleanup,
        orchestrationBridge.cleanup,
      );

      const serverHandle = yield* Effect.tryPromise({
        try: () =>
          deps.serverManager.acquire({
            provider: deps.provider,
            binaryPath: settings.binaryPath,
            ...(serverDirectory ? { directory: serverDirectory } : {}),
            executionTargetId: executionContext.providerRuntimeTarget.executionTargetId,
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: deps.provider,
            threadId: input.threadId,
            detail: toMessage(cause, `Failed to start ${deps.provider} server.`),
            cause,
          }),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            void cleanupBridge().catch(() => undefined);
          }),
        ),
      );
      yield* Effect.tryPromise({
        try: () =>
          registerOpencodeOrchestrationMcpBridge({
            client: serverHandle.client,
            ...(serverDirectory ? { directory: serverDirectory } : {}),
            bridge: orchestrationBridge,
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: deps.provider,
            threadId: input.threadId,
            detail: toMessage(
              cause,
              `Failed to register ${deps.provider} orchestration MCP bridge.`,
            ),
            cause,
          }),
      }).pipe(
        Effect.timeout(OPENCODE_ORCHESTRATION_MCP_REGISTRATION_TIMEOUT),
        Effect.catchCause((cause) =>
          Effect.logWarning("opencode orchestration MCP registration failed; continuing", {
            provider: deps.provider,
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      const client = serverHandle.client;
      const cleanupConnectedBridge = composeBridgeCleanups(async () => {
        try {
          await disconnectOpencodeOrchestrationMcpBridge({
            client,
            ...(serverDirectory ? { directory: serverDirectory } : {}),
            serverName: orchestrationBridge.serverName,
          });
        } catch {
          // Best effort: bridge cleanup below removes BigBud auth and files.
        }
      }, cleanupBridge);
      const allowedTools = yield* Effect.tryPromise({
        try: async () => {
          const toolIdsResponse = await client.tool.ids(
            serverDirectory ? { directory: serverDirectory } : undefined,
          );
          if (toolIdsResponse.error || !Array.isArray(toolIdsResponse.data)) {
            throw new Error(
              `Failed to list ${deps.provider} tool IDs: ${String(toolIdsResponse.error)}`,
            );
          }
          return buildOpencodeAllowedTools({
            toolIds: toolIdsResponse.data,
            serverName: orchestrationBridge.serverName,
          });
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: deps.provider,
            threadId: input.threadId,
            detail: toMessage(
              cause,
              `Failed to resolve ${deps.provider} tool availability for this thread.`,
            ),
            cause,
          }),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            serverHandle.release();
            void cleanupConnectedBridge().catch(() => undefined);
          }),
        ),
      );

      let modelID: string | undefined;
      let providerID: string | undefined;
      if (isProviderModelSelection(input.modelSelection, deps.provider)) {
        modelID = input.modelSelection.model;
        const selectionProviderID =
          "subProviderID" in input.modelSelection
            ? (input.modelSelection as { subProviderID?: string }).subProviderID
            : undefined;
        providerID =
          selectionProviderID ??
          (yield* Effect.tryPromise({
            try: () => resolveProviderIDForModel(client, modelID!),
            catch: () => undefined as never,
          }).pipe(Effect.orElseSucceed(() => undefined)));
      }

      const sessionResp = yield* Effect.tryPromise({
        try: () =>
          client.session.create({
            ...(input.cwd ? { title: `bigbud session in ${input.cwd}` } : {}),
            permission: buildOpenCodePermissionRules(input.runtimeMode),
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: deps.provider,
            threadId: input.threadId,
            detail: toMessage(cause, `Failed to create ${deps.provider} session.`),
            cause,
          }),
      });

      if (sessionResp.error || !sessionResp.data) {
        serverHandle.release();
        void cleanupBridge().catch(() => undefined);
        return yield* new ProviderAdapterProcessError({
          provider: deps.provider,
          threadId: input.threadId,
          detail: `Failed to create ${deps.provider} session: ${String(sessionResp.error)}`,
        });
      }

      const opencodeSessionId = sessionResp.data.id;
      const createdAt = new Date().toISOString();

      const record: ActiveOpencodeSession = {
        client,
        releaseServer: () => serverHandle.release(),
        cleanupBridge: cleanupConnectedBridge,
        opencodeSessionId,
        threadId: input.threadId,
        createdAt,
        runtimeMode: input.runtimeMode,
        providerRuntimeExecutionTargetId:
          executionContext.executionTargets.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: executionContext.executionTargets.workspaceExecutionTargetId,
        executionTargetId: executionContext.executionTargets.executionTargetId,
        pendingPermissions: new Map(),
        pendingUserInputs: new Map(),
        turns: [],
        sseAbortController: null,
        cwd: input.cwd,
        model: modelID,
        providerID,
        updatedAt: createdAt,
        lastError: undefined,
        activeTurnId: undefined,
        lastUsage: undefined,
        wasRetrying: false,
        reasoningPartIds: new Set(),
        allowedTools,
      };

      deps.sessions.set(input.threadId, record);

      startEventStream(
        record,
        deps.handleEventFn,
        deps.syntheticEventFn,
        deps.emitFn,
        deps.services,
      );

      yield* deps.emitFn([
        yield* deps.syntheticEventFn(
          input.threadId,
          "session.started",
          input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        ),
        yield* deps.syntheticEventFn(input.threadId, "thread.started", {
          providerThreadId: opencodeSessionId,
        }),
        yield* deps.syntheticEventFn(input.threadId, "session.state.changed", {
          state: "ready",
          reason: "session.started",
        }),
      ]);

      return {
        provider: deps.provider,
        status: "ready",
        runtimeMode: input.runtimeMode,
        providerRuntimeExecutionTargetId:
          executionContext.executionTargets.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: executionContext.executionTargets.workspaceExecutionTargetId,
        threadId: input.threadId,
        executionTargetId: executionContext.executionTargets.executionTargetId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelID ? { model: modelID } : {}),
        resumeCursor: { sessionId: opencodeSessionId },
        createdAt,
        updatedAt: createdAt,
      } satisfies ProviderSession;
    });
}
