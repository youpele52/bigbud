import { Effect } from "effect";

import { ProviderAdapterRequestError } from "../../Errors.ts";
import type { PiAdapterShape } from "../../Services/Pi/Adapter.ts";
import type { ActivePiSession, PiEmitEvents, PiSyntheticEventFn } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { normalizeString, toMessage } from "./Adapter.utils.ts";

export function makeRespondToUserInput(input: {
  readonly requireSession: (
    threadId: string,
  ) => Effect.Effect<ActivePiSession, ProviderAdapterRequestError>;
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
}): PiAdapterShape["respondToUserInput"] {
  return Effect.fn("respondToUserInput")(function* (threadId, requestId, answers) {
    const session = yield* input.requireSession(threadId);
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
    yield* input.emit([
      yield* input.makeSyntheticEvent(
        threadId,
        "user-input.resolved",
        { answers },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId,
        },
      ),
      yield* input.makeSyntheticEvent(threadId, "session.state.changed", {
        state: session.activeTurnId ? "running" : "ready",
        reason: "user-input.resolved",
      }),
    ]);
  });
}
