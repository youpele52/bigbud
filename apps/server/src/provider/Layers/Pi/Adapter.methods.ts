import { randomUUID } from "node:crypto";

import {
  ThreadId,
  TurnId,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { createPiOrchestrationBridge } from "../../../orchestration-tools/PiOrchestrationBridge.ts";
import { resolveProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { resolveWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";
import { resolveProviderSessionExecutionTargets } from "../../providerSessionExecutionTargets.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../../Errors.ts";
import type { PiAdapterShape } from "../../Services/Pi/Adapter.ts";
import type {
  ActivePiSession,
  PiEmitEvents,
  PiProcessExitHandler,
  PiRunPromise,
  PiStdoutEventHandler,
  PiSyntheticEventFn,
} from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { createPiRpcProcess } from "./RpcProcess.ts";
import {
  appendPiAttachmentInstructions,
  applyModelSelection,
  buildResumeCursor,
  makeAppendTextFileAttachments,
  makeResolveImages,
  makeStopSessionRecord,
  refreshSessionState,
} from "./Adapter.session.helpers.ts";
import { makePiSessionControlMethods } from "./Adapter.session.control.ts";
import { makeRespondToUserInput } from "./Adapter.methods.respondToUserInput.ts";
import { normalizeString, readResumeCursor, toMessage } from "./Adapter.utils.ts";

export function makePiAdapterMethods(deps: {
  readonly attachmentsDir: string;
  readonly stateDir: string;
  readonly host: string | undefined;
  readonly port: number;
  readonly emit: PiEmitEvents;
  readonly handleProcessExit: PiProcessExitHandler;
  readonly handleStdoutEvent: PiStdoutEventHandler;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly runPromise: PiRunPromise;
  readonly serverSettings: Pick<ServerSettingsShape, "getSettings">;
  readonly sessions: Map<ThreadId, ActivePiSession>;
}) {
  const resolveImages = makeResolveImages(deps.attachmentsDir);
  const appendTextFileAttachments = makeAppendTextFileAttachments(deps.attachmentsDir);
  const stopSessionRecord = makeStopSessionRecord({
    emit: deps.emit,
    makeSyntheticEvent: deps.makeSyntheticEvent,
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ActivePiSession, ProviderAdapterSessionNotFoundError> => {
    const session = deps.sessions.get(threadId);
    return session
      ? Effect.succeed(session)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(function* (input) {
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
    };

    const onExit = () => {
      const detail = normalizeString(session.process.stderrTail()) ?? "Pi RPC process exited.";
      void deps
        .handleProcessExit(session, detail)
        .pipe(deps.runPromise)
        .catch(() => undefined);
    };

    // Register in sessions map BEFORE subscribing so that onExit can find the session
    // if the process exits during setup, and so cleanup in Effect.onError works correctly.
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
        "session.started",
        input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
      ),
      yield* deps.makeSyntheticEvent(
        input.threadId,
        "thread.started",
        session.sessionId ? { providerThreadId: session.sessionId } : {},
      ),
      yield* deps.makeSyntheticEvent(input.threadId, "session.state.changed", {
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
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(session.model ? { model: session.model } : {}),
      resumeCursor: buildResumeCursor(session),
      createdAt,
      updatedAt: session.updatedAt,
    } satisfies ProviderSession;
  });

  const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const session = yield* requireSession(input.threadId);

    if ((!input.input || input.input.trim().length === 0) && !input.attachments?.length) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi turns require input text or at least one image attachment.",
      });
    }

    if (input.modelSelection) {
      yield* applyModelSelection({ session, modelSelection: input.modelSelection });
    }

    const turnId = TurnId.makeUnsafe(`pi-turn-${randomUUID()}`);
    const queuedWhileRunning = session.activeTurnId !== undefined;
    if (queuedWhileRunning) {
      session.queuedTurnIds.push(turnId);
    } else {
      session.activeTurnId = turnId;
    }
    session.updatedAt = new Date().toISOString();
    session.turns.push({ id: turnId, items: [] });

    const images = yield* resolveImages(input.attachments ?? []);
    const attachmentAwareInput = appendPiAttachmentInstructions({
      prompt: input.input ?? "",
      hasFileAttachments: (input.attachments ?? []).some(
        (attachment) => attachment.type === "file",
      ),
    });
    const messageText = yield* appendTextFileAttachments(
      input.attachments ?? [],
      attachmentAwareInput,
    );
    yield* Effect.tryPromise({
      try: () =>
        session.process.request({
          type: "prompt",
          message: messageText,
          ...(images.length > 0 ? { images } : {}),
          ...(queuedWhileRunning ? { streamingBehavior: "steer" as const } : {}),
        }),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: toMessage(cause, "Failed to send Pi turn."),
          cause,
        }),
    }).pipe(
      Effect.tapError((error) =>
        Effect.logError("Pi prompt RPC request failed", {
          threadId: input.threadId,
          turnId,
          detail: error.detail,
        }),
      ),
      Effect.tapError(() =>
        Effect.sync(() => {
          if (queuedWhileRunning) {
            const queuedTurnIndex = session.queuedTurnIds.findIndex(
              (queuedTurnId) => queuedTurnId === turnId,
            );
            if (queuedTurnIndex !== -1) {
              session.queuedTurnIds.splice(queuedTurnIndex, 1);
            }
            const turnIndex = session.turns.findIndex((turn) => turn.id === turnId);
            if (turnIndex !== -1) {
              session.turns.splice(turnIndex, 1);
            }
            return;
          }
          session.activeTurnId = undefined;
          const turnIndex = session.turns.findIndex((turn) => turn.id === turnId);
          if (turnIndex !== -1) {
            session.turns.splice(turnIndex, 1);
          }
        }),
      ),
    );

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: buildResumeCursor(session),
    } satisfies ProviderTurnStartResult;
  });

  const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const session = yield* requireSession(threadId);
      yield* Effect.tryPromise({
        try: () => session.process.write({ type: "abort" }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "abort",
            detail: toMessage(cause, "Failed to interrupt Pi turn."),
            cause,
          }),
      });
    },
  );

  const respondToRequest: PiAdapterShape["respondToRequest"] = (_threadId, _requestId, _decision) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToRequest",
        issue:
          "Pi adapter does not expose approval requests separately in the current implementation.",
      }),
    );

  const respondToUserInput = makeRespondToUserInput({
    requireSession: requireSession as never,
    emit: deps.emit,
    makeSyntheticEvent: deps.makeSyntheticEvent,
  });

  const sessionControlMethods = makePiSessionControlMethods({
    emit: deps.emit,
    makeSyntheticEvent: deps.makeSyntheticEvent,
    sessions: deps.sessions,
    stopSessionRecord,
    requireSession,
  });

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    ...sessionControlMethods,
  } satisfies Pick<
    PiAdapterShape,
    | "startSession"
    | "sendTurn"
    | "interruptTurn"
    | "respondToRequest"
    | "respondToUserInput"
    | "stopSession"
    | "listSessions"
    | "hasSession"
    | "readThread"
    | "rollbackThread"
    | "stopAll"
  >;
}
