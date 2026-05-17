import {
  LOCAL_EXECUTION_TARGET_ID,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@bigbud/contracts";
import { type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { Effect, type ServiceMap } from "effect";

import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../../Errors.ts";
import type { OpencodeAdapterShape } from "../../Services/Opencode/Adapter.ts";
import type { OpencodeServerManagerShape } from "../../Services/Opencode/ServerManager.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";
import type { SyntheticEventFn } from "./Adapter.stream.primitives.ts";
import {
  buildOpenCodePermissionRules,
  isOpencodeModelSelection,
  resolveProviderIDForModel,
} from "./Adapter.session.helpers.ts";
import { createOpencodeRemoteWorkspaceBridge } from "./OpencodeRemoteWorkspaceBridge.ts";
import { getProviderCapabilities } from "../../providerCapabilities.ts";
import { resolveProviderExecutionContext } from "../../providerExecutionContext.ts";
import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { isRemoteWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { startEventStream, toMessage } from "./Adapter.stream.ts";

export interface StartSessionDeps {
  readonly sessions: Map<string, ActiveOpencodeSession>;
  readonly serverManager: OpencodeServerManagerShape;
  readonly serverSettings: Pick<ServerSettingsShape, "getSettings">;
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

      const opencodeSettings = yield* deps.serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.opencode),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to read OpenCode settings."),
              cause,
            }),
        ),
      );
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
              try: () => createOpencodeRemoteWorkspaceBridge(executionContext.workspaceTarget),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: toMessage(cause, "Failed to prepare OpenCode remote workspace bridge."),
                  cause,
                }),
            })
          : undefined;

      const serverHandle = yield* Effect.tryPromise({
        try: () =>
          deps.serverManager.acquire({
            binaryPath: opencodeSettings.binaryPath,
            ...(remoteWorkspaceBridge?.cwd
              ? { directory: remoteWorkspaceBridge.cwd }
              : input.cwd
                ? { directory: input.cwd }
                : {}),
            executionTargetId: executionContext.providerRuntimeTarget.executionTargetId,
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start OpenCode server."),
            cause,
          }),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            void remoteWorkspaceBridge?.cleanup().catch(() => undefined);
          }),
        ),
      );
      const client = serverHandle.client;

      let modelID: string | undefined;
      let providerID: string | undefined;
      if (isOpencodeModelSelection(input.modelSelection)) {
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
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to create OpenCode session."),
            cause,
          }),
      });

      if (sessionResp.error || !sessionResp.data) {
        serverHandle.release();
        void remoteWorkspaceBridge?.cleanup().catch(() => undefined);
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: `Failed to create OpenCode session: ${String(sessionResp.error)}`,
        });
      }

      const opencodeSessionId = sessionResp.data.id;
      const createdAt = new Date().toISOString();

      const record: ActiveOpencodeSession = {
        client,
        releaseServer: () => serverHandle.release(),
        ...(remoteWorkspaceBridge ? { cleanupBridge: remoteWorkspaceBridge.cleanup } : {}),
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
        provider: PROVIDER,
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
