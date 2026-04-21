import { randomUUID } from "node:crypto";

import {
  ThreadId,
  TurnId,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type { ServerSettingsShape } from "../../ws/serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import type {
  ActivePiSession,
  PiEmitEvents,
  PiProcessExitHandler,
  PiRunPromise,
  PiStdoutEventHandler,
  PiSyntheticEventFn,
} from "./PiAdapter.types.ts";
import { PROVIDER } from "./PiAdapter.types.ts";
import { createPiRpcProcess } from "./PiRpcProcess.ts";
import {
  applyModelSelection,
  buildResumeCursor,
  makeAppendTextFileAttachments,
  makeResolveImages,
  makeStopSessionRecord,
  refreshSessionState,
} from "./PiAdapter.session.helpers.ts";
import {
  appendTurnItems,
  buildThreadSnapshot,
  normalizeString,
  readResumeCursor,
  toMessage,
} from "./PiAdapter.utils.ts";

export function makePiAdapterMethods(deps: {
  readonly attachmentsDir: string;
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
    const rpcProcess = yield* Effect.tryPromise({
      try: () =>
        createPiRpcProcess({
          binaryPath: piSettings.binaryPath,
          ...(input.cwd ? { cwd: input.cwd } : {}),
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
      cwd: input.cwd,
      model: undefined,
      providerID: undefined,
      thinkingLevel: undefined,
      updatedAt: createdAt,
      lastError: undefined,
      activeTurnId: undefined,
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
    if (session.activeTurnId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi session is already processing a turn.",
      });
    }

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
    session.activeTurnId = turnId;
    session.updatedAt = new Date().toISOString();
    session.turns.push({ id: turnId, items: [] });

    const images = yield* resolveImages(input.attachments ?? []);
    const messageText = yield* appendTextFileAttachments(
      input.attachments ?? [],
      input.input ?? "",
    );
    const startedEvent = yield* deps.makeSyntheticEvent(
      input.threadId,
      "turn.started",
      {
        ...(session.model ? { model: session.model } : {}),
        ...(session.thinkingLevel ? { effort: session.thinkingLevel } : {}),
      },
      { turnId },
    );
    const runningEvent = yield* deps.makeSyntheticEvent(input.threadId, "session.state.changed", {
      state: "running",
      reason: "turn.started",
    });
    yield* deps.emit([startedEvent, runningEvent]);
    appendTurnItems(session, [startedEvent, runningEvent]);

    const state = yield* refreshSessionState(session).pipe(Effect.orElseSucceed(() => undefined));
    const isStreaming = state?.isStreaming === true;
    yield* Effect.tryPromise({
      try: () =>
        session.process.request({
          type: "prompt",
          message: messageText,
          ...(images.length > 0 ? { images } : {}),
          ...(isStreaming ? { streamingBehavior: "followUp" as const } : {}),
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
          session.activeTurnId = undefined;
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
        try: () => session.process.request({ type: "abort" }),
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

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn("respondToUserInput")(
    function* (threadId, requestId, answers) {
      const session = yield* requireSession(threadId);
      const pending = session.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown pending Pi user-input request '${requestId}'.`,
        });
      }
      if (pending.responding) {
        return;
      }
      pending.responding = true;

      const answerForQuestion = answers[pending.question.id];
      const firstAnswer = Object.values(answers)[0];
      const resolvedValue = answerForQuestion ?? firstAnswer;
      const request = yield* Effect.sync(() => {
        if (pending.question.options.length > 0) {
          const choice = Array.isArray(resolvedValue)
            ? normalizeString(resolvedValue[0])
            : normalizeString(resolvedValue);
          if (!choice) {
            return { type: "extension_ui_response", id: requestId, cancelled: true } as const;
          }
          if (
            pending.question.options.some((option) => option.label === "Yes") &&
            pending.question.options.some((option) => option.label === "No")
          ) {
            return {
              type: "extension_ui_response",
              id: requestId,
              confirmed: choice === "Yes",
            } as const;
          }
          return { type: "extension_ui_response", id: requestId, value: choice } as const;
        }

        const textValue = Array.isArray(resolvedValue)
          ? normalizeString(resolvedValue[0])
          : normalizeString(resolvedValue);
        return textValue
          ? ({ type: "extension_ui_response", id: requestId, value: textValue } as const)
          : ({ type: "extension_ui_response", id: requestId, cancelled: true } as const);
      });

      yield* Effect.tryPromise({
        try: () => session.process.write(request),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: toMessage(cause, "Failed to respond to Pi user-input request."),
            cause,
          }),
      });

      session.pendingUserInputs.delete(requestId);
      yield* deps.emit([
        yield* deps.makeSyntheticEvent(
          threadId,
          "user-input.resolved",
          { answers },
          {
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            requestId,
          },
        ),
        yield* deps.makeSyntheticEvent(threadId, "session.state.changed", {
          state: session.activeTurnId ? "running" : "ready",
          reason: "user-input.resolved",
        }),
      ]);
    },
  );

  const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(function* (threadId) {
    const session = yield* requireSession(threadId);
    deps.sessions.delete(threadId);
    yield* stopSessionRecord(session);
    yield* deps.emit([
      yield* deps.makeSyntheticEvent(threadId, "session.state.changed", {
        state: "stopped",
        reason: "session.stopped",
      }),
      yield* deps.makeSyntheticEvent(threadId, "session.exited", {
        reason: "session.stopped",
        recoverable: true,
        exitKind: "graceful",
      }),
    ]);
  });

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.sync(() =>
      [...deps.sessions.values()].map(
        (session) =>
          Object.assign(
            {
              provider: PROVIDER,
              status: session.activeTurnId ? "running" : "ready",
              runtimeMode: session.runtimeMode,
              threadId: session.threadId,
              resumeCursor: buildResumeCursor(session),
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            },
            session.cwd ? { cwd: session.cwd } : {},
            session.model ? { model: session.model } : {},
            session.activeTurnId ? { activeTurnId: session.activeTurnId } : {},
            session.lastError ? { lastError: session.lastError } : {},
          ) satisfies ProviderSession,
      ),
    );

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(deps.sessions.has(threadId));

  const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
    const session = yield* requireSession(threadId);
    return buildThreadSnapshot(session);
  });

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "Pi sessions do not support rolling back conversation state.",
      }),
    ).pipe(Effect.annotateLogs({ threadId }));

  const stopAll: PiAdapterShape["stopAll"] = Effect.fn("stopAll")(function* () {
    yield* Effect.forEach(
      Array.from(deps.sessions.values()),
      (session) =>
        Effect.gen(function* () {
          deps.sessions.delete(session.threadId);
          yield* stopSessionRecord(session);
          yield* deps.emit([
            yield* deps.makeSyntheticEvent(session.threadId, "session.state.changed", {
              state: "stopped",
              reason: "session.stopped",
            }),
            yield* deps.makeSyntheticEvent(session.threadId, "session.exited", {
              reason: "session.stopped",
              recoverable: true,
              exitKind: "graceful",
            }),
          ]);
        }),
      { concurrency: "unbounded" },
    );
  });

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
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
