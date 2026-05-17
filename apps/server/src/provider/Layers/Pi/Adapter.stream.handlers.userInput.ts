import { FULL_ACCESS_AUTO_APPROVE_AFTER_MS } from "@bigbud/shared/approvals";
import { ThreadId, type UserInputQuestion } from "@bigbud/contracts";
import { Effect } from "effect";

import { ProviderAdapterRequestError } from "../../Errors.ts";
import type {
  ActivePiSession,
  PiEmitEvents,
  PiRunPromise,
  PiSyntheticEventFn,
} from "./Adapter.types.ts";
import { PROVIDER, USER_INPUT_FALLBACK_QUESTION_ID } from "./Adapter.types.ts";
import type { PiRpcExtensionUIRequest } from "./RpcProcess.ts";
import { normalizeString, toMessage } from "./Adapter.utils.ts";
import { emitWithTurnAppend } from "./Adapter.stream.handlers.ts";

function buildQuestion(message: PiRpcExtensionUIRequest): UserInputQuestion | undefined {
  switch (message.method) {
    case "select": {
      const title = normalizeString(message.title) ?? "Selection";
      const options = message.options
        .map((entry) => normalizeString(entry))
        .filter((entry): entry is string => entry !== undefined)
        .map((entry) => ({ label: entry, description: entry }));
      return {
        id: USER_INPUT_FALLBACK_QUESTION_ID,
        header: title,
        question: title,
        options,
      };
    }
    case "confirm": {
      const title = normalizeString(message.title) ?? "Confirmation";
      const body = normalizeString(message.message);
      return {
        id: USER_INPUT_FALLBACK_QUESTION_ID,
        header: title,
        question: body ?? title,
        options: [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ],
      };
    }
    case "input": {
      const title = normalizeString(message.title) ?? "Input";
      const placeholder = normalizeString(message.placeholder);
      return {
        id: USER_INPUT_FALLBACK_QUESTION_ID,
        header: title,
        question: placeholder ?? title,
        options: [],
      };
    }
    case "editor": {
      const title = normalizeString(message.title) ?? "Editor";
      return {
        id: USER_INPUT_FALLBACK_QUESTION_ID,
        header: title,
        question: title,
        options: [],
      };
    }
    default:
      return undefined;
  }
}

function autoResolveConfirm(deps: {
  readonly session: ActivePiSession;
  readonly requestId: string;
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly runPromise: PiRunPromise;
  readonly sessions: Map<ThreadId, ActivePiSession>;
}) {
  return Effect.gen(function* () {
    yield* Effect.sleep(FULL_ACCESS_AUTO_APPROVE_AFTER_MS);
    const pending = deps.session.pendingUserInputs.get(deps.requestId);
    if (!pending || pending.responding || !deps.sessions.has(deps.session.threadId)) {
      return;
    }
    pending.responding = true;
    yield* Effect.tryPromise({
      try: () =>
        deps.session.process.write({
          type: "extension_ui_response",
          id: deps.requestId,
          confirmed: true,
        }),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: toMessage(cause, "Failed to auto-respond to Pi confirm request."),
          cause,
        }),
    }).pipe(Effect.orElseSucceed(() => undefined));

    if (!deps.session.pendingUserInputs.has(deps.requestId)) {
      return;
    }
    deps.session.pendingUserInputs.delete(deps.requestId);
    yield* deps.emit([
      yield* deps.makeSyntheticEvent(
        deps.session.threadId,
        "user-input.resolved",
        { answers: { [pending.question.id]: "Yes" } },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId: deps.requestId,
        },
      ),
      yield* deps.makeSyntheticEvent(deps.session.threadId, "session.state.changed", {
        state: deps.session.activeTurnId ? "running" : "ready",
        reason: "user-input.resolved",
      }),
    ]);
  })
    .pipe(deps.runPromise)
    .catch(() => undefined);
}

export const handleExtensionUiRequest = Effect.fn("handleExtensionUiRequest")(function* (deps: {
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly runPromise: PiRunPromise;
  readonly session: ActivePiSession;
  readonly sessions: Map<ThreadId, ActivePiSession>;
  readonly message: PiRpcExtensionUIRequest;
}) {
  if (
    deps.message.method === "notify" ||
    deps.message.method === "setStatus" ||
    deps.message.method === "setWidget" ||
    deps.message.method === "setTitle" ||
    deps.message.method === "set_editor_text"
  ) {
    return;
  }

  const question = buildQuestion(deps.message);
  if (!question) {
    return;
  }

  deps.session.pendingUserInputs.set(deps.message.id, {
    requestId: deps.message.id,
    turnId: deps.session.activeTurnId,
    question,
    responding: false,
  });

  const opened = yield* deps.makeSyntheticEvent(
    deps.session.threadId,
    "user-input.requested",
    { questions: [question] },
    {
      ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
      requestId: deps.message.id,
    },
  );
  const waiting = yield* deps.makeSyntheticEvent(deps.session.threadId, "session.state.changed", {
    state: "waiting",
    reason: "user-input.requested",
  });
  yield* emitWithTurnAppend({ emit: deps.emit, session: deps.session, events: [opened, waiting] });

  if (deps.session.runtimeMode === "full-access" && deps.message.method === "confirm") {
    void autoResolveConfirm({
      session: deps.session,
      requestId: deps.message.id,
      emit: deps.emit,
      makeSyntheticEvent: deps.makeSyntheticEvent,
      runPromise: deps.runPromise,
      sessions: deps.sessions,
    });
  }
});
