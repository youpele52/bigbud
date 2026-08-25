import type { ProviderSession } from "@bigbud/contracts/orchestration/provider.ts";
import { Effect } from "effect";

import { createPiOrchestrationBridge } from "../../../orchestration-tools/PiOrchestrationBridge.ts";
import { resolveProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { resolveWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { resolveProviderSessionExecutionTargets } from "../../providerSessionExecutionTargets.ts";
import { ProviderAdapterProcessError } from "../../Errors.ts";
import type { PiAdapterShape } from "../../Services/Pi/Adapter.ts";
import {
  applyModelSelection,
  buildResumeCursor,
  refreshSessionState,
} from "./Adapter.session.helpers.ts";
import type { ActivePiSession } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { PiAdapterMethodDependencies } from "./Adapter.methods.types.ts";
import { createPiRpcProcess } from "./RpcProcess.ts";
import { normalizeString, readResumeCursor, toMessage } from "./Adapter.utils.ts";

export function makePiStartSession(
  deps: PiAdapterMethodDependencies,
): PiAdapterShape["startSession"] {
  return Effect.fn("startSession")(function* (input) {
    const piSettings = yield* deps.serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.pi),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to read Pi settings."),
            cause,
          }),
      ),
    );

    const resumeCursor = readResumeCursor(input.resumeCursor);
    const createdAt = new Date().toISOString();
    const sessionEpoch = input.sessionEpoch ?? 0;
    const executionTargets = resolveProviderSessionExecutionTargets({
      providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId: input.workspaceExecutionTargetId,
      executionTargetId: input.executionTargetId,
      useLegacyExecutionTargetForProviderRuntime: false,
    });
    const providerRuntimeTarget = resolveProviderRuntimeTarget({
      executionTargetId: executionTargets.providerRuntimeExecutionTargetId,
    });
    const workspaceTarget = resolveWorkspaceTarget({
      executionTargetId: executionTargets.workspaceExecutionTargetId,
      cwd: input.cwd,
    });
    const orchestrationBridge = yield* Effect.tryPromise({
      try: () =>
        createPiOrchestrationBridge({
          stateDir: deps.stateDir,
          threadId: input.threadId,
          host: deps.host,
          port: deps.port,
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to prepare Pi thread orchestration bridge."),
          cause,
        }),
    });
    const rpcProcess = yield* Effect.tryPromise({
      try: () =>
        createPiRpcProcess({
          binaryPath: piSettings.binaryPath,
          providerRuntimeTarget,
          workspaceTarget,
          orchestrationBridge,
          ...(resumeCursor?.sessionFile ? { sessionFile: resumeCursor.sessionFile } : {}),
          env: process.env,
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to start Pi RPC process."),
          cause,
        }),
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          void orchestrationBridge.cleanup().catch(() => undefined);
        }),
      ),
      Effect.tapError((error) =>
        Effect.logError("Pi RPC process failed to start", {
          threadId: input.threadId,
          detail: error.detail,
        }),
      ),
    );

    const session: ActivePiSession = {
      process: rpcProcess,
      threadId: input.threadId,
      sessionEpoch,
      createdAt,
      runtimeMode: input.runtimeMode,
      pendingUserInputs: new Map(),
      turns: [],
      unsubscribe: () => undefined,
      providerRuntimeExecutionTargetId: executionTargets.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId: executionTargets.workspaceExecutionTargetId,
      executionTargetId: executionTargets.executionTargetId,
      cwd: input.cwd,
      model: undefined,
      providerID: undefined,
      thinkingLevel: undefined,
      updatedAt: createdAt,
      lastError: undefined,
      agentRunning: false,
      activeTurnId: undefined,
      queuedTurnIds: [],
      pendingTurnEnd: undefined,
      completedTurnBoundary: undefined,
      lastUsage: undefined,
      sessionId: resumeCursor?.sessionId,
      sessionFile: resumeCursor?.sessionFile,
      currentAssistantMessageId: undefined,
      currentToolOutputById: new Map(),
      currentToolInfoById: new Map(),
      lastPlanFingerprint: undefined,
    };

    const onExit = () => {
      const detail = normalizeString(session.process.stderrTail()) ?? "Pi RPC process exited.";
      void deps
        .handleProcessExit(session, detail)
        .pipe(deps.runPromise)
        .catch(() => undefined);
    };

    deps.sessions.set(input.threadId, session);

    session.unsubscribe = session.process.subscribe((message) => {
      void deps
        .handleStdoutEvent(session, message)
        .pipe(deps.runPromise)
        .catch(() => undefined);
    });
    session.process.child.once("exit", onExit);

    yield* Effect.gen(function* () {
      yield* refreshSessionState(session).pipe(Effect.orElseSucceed(() => undefined));
      if (input.modelSelection) {
        yield* applyModelSelection({ session, modelSelection: input.modelSelection }).pipe(
          Effect.tapError((error) =>
            Effect.logError("Pi model selection failed during startSession", {
              threadId: input.threadId,
              error: "message" in error ? error.message : String(error),
            }),
          ),
        );
        yield* refreshSessionState(session).pipe(Effect.orElseSucceed(() => undefined));
      }
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          session.unsubscribe();
          deps.sessions.delete(input.threadId);
          void session.process.stop().catch(() => undefined);
        }),
      ),
    );

    yield* deps.emit([
      yield* deps.makeSyntheticEvent(
        input.threadId,
        sessionEpoch,
        "session.started",
        input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
      ),
      yield* deps.makeSyntheticEvent(
        input.threadId,
        sessionEpoch,
        "thread.started",
        session.sessionId ? { providerThreadId: session.sessionId } : {},
      ),
      yield* deps.makeSyntheticEvent(input.threadId, sessionEpoch, "session.state.changed", {
        state: "ready",
        reason: "session.started",
      }),
    ]);

    return {
      provider: PROVIDER,
      status: "ready",
      runtimeMode: input.runtimeMode,
      providerRuntimeExecutionTargetId: executionTargets.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId: executionTargets.workspaceExecutionTargetId,
      executionTargetId: executionTargets.executionTargetId,
      threadId: input.threadId,
      sessionEpoch,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(session.model ? { model: session.model } : {}),
      resumeCursor: buildResumeCursor(session),
      createdAt,
      updatedAt: session.updatedAt,
    } satisfies ProviderSession;
  });
}
