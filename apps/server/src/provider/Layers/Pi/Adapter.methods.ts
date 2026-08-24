import { randomUUID } from "node:crypto";

import { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderTurnStartResult } from "@bigbud/contracts/orchestration/provider.ts";
import { Effect } from "effect";

import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../../Errors.ts";
import type { PiAdapterShape } from "../../Services/Pi/Adapter.ts";
import { PROVIDER } from "./Adapter.types.ts";
import {
  appendPiAttachmentInstructions,
  applyModelSelection,
  buildResumeCursor,
} from "./Adapter.session.helpers.ts";
import { makePiSessionControlMethods } from "./Adapter.session.control.ts";
import { makeRespondToUserInput } from "./Adapter.methods.respondToUserInput.ts";
import { requirePiSession } from "./Adapter.methods.session.ts";
import { createPiMethodSetup } from "./Adapter.methods.setup.ts";
import { makePiStartSession } from "./Adapter.methods.startSession.ts";
import type { PiAdapterMethodDependencies } from "./Adapter.methods.types.ts";
import { toMessage } from "./Adapter.utils.ts";

export function makePiAdapterMethods(deps: PiAdapterMethodDependencies) {
  const { appendTextFileAttachments, resolveImages, stopSessionRecord } = createPiMethodSetup({
    attachmentsDir: deps.attachmentsDir,
    emit: deps.emit,
    makeSyntheticEvent: deps.makeSyntheticEvent,
  });

  const requireSession = (threadId: ThreadId) => requirePiSession(deps.sessions, threadId);

  const startSession = makePiStartSession(deps);

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
    session.lastPlanFingerprint = undefined;
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

  const steerTurn: NonNullable<PiAdapterShape["steerTurn"]> = Effect.fn("steerTurn")(
    function* (threadId, input, turnId) {
      const session = yield* requireSession(threadId);
      if (turnId !== undefined && session.activeTurnId !== turnId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "steerTurn",
          issue: "The requested turn is no longer active.",
        });
      }
      yield* Effect.tryPromise({
        try: () => session.process.request({ type: "steer", message: input }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "steer",
            detail: toMessage(cause, "Failed to steer the Pi turn."),
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
    steerTurn,
    respondToRequest,
    respondToUserInput,
    ...sessionControlMethods,
  } satisfies Pick<
    PiAdapterShape,
    | "startSession"
    | "sendTurn"
    | "interruptTurn"
    | "steerTurn"
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
