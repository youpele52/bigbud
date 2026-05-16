/**
 * OpencodeAdapter session turn methods — `interruptTurn`,
 * `respondToRequest`, and `respondToUserInput`.
 *
 * @module OpencodeAdapter.session.turn
 */
import { Effect } from "effect";

import { ProviderAdapterRequestError } from "../../Errors.ts";
import type { OpencodeAdapterShape } from "../../Services/Opencode/Adapter.ts";
import { toMessage } from "./Adapter.stream.ts";
import { approvalDecisionToOpencodeResponse } from "./Adapter.session.helpers.ts";
import { openCodeQuestionId } from "./Adapter.stream.mapEvent.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { makeSendTurnMethod } from "./Adapter.session.turn.sendTurn.ts";

import type { TurnMethodDeps } from "./Adapter.session.ts";

// ── Answer mapping helper ─────────────────────────────────────────────

/**
 * Map a flat `Record<questionId, answer>` (keyed by `openCodeQuestionId`)
 * to the v2 `Array<QuestionAnswer>` format (one `string[]` per question).
 */
function toOpencodeQuestionAnswers(
  questions: ReadonlyArray<{ header: string; question?: string }>,
  answers: Record<string, unknown>,
): Array<Array<string>> {
  return questions.map((q, index) => {
    const value =
      answers[openCodeQuestionId(index, q.header)] ??
      answers[q.header] ??
      (q.question ? answers[q.question] : undefined);
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return [value.trim()];
    }
    return [];
  });
}

// ── Turn method factories ─────────────────────────────────────────────

export function makeTurnMethods(deps: TurnMethodDeps) {
  const { requireSession, syntheticEventFn, emitFn } = deps;

  const sendTurn = makeSendTurnMethod(deps);

  const interruptTurn: OpencodeAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      yield* Effect.tryPromise({
        try: () =>
          record.client.session.abort({
            sessionID: record.opencodeSessionId,
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.abort",
            detail: toMessage(cause, "Failed to interrupt OpenCode turn."),
            cause,
          }),
      });
    });

  const respondToRequest: OpencodeAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      const pending = record.pendingPermissions.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.permission.respond",
          detail: `Unknown pending OpenCode permission request '${requestId}'.`,
        });
      }

      if (pending.responding) {
        return;
      }

      pending.responding = true;

      // Respond via the OpenCode SDK permission API
      yield* Effect.tryPromise({
        try: () =>
          record.client.permission.reply({
            requestID: pending.requestId,
            reply: approvalDecisionToOpencodeResponse(decision),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.permission.respond",
            detail: toMessage(cause, "Failed to respond to OpenCode permission request."),
            cause,
          }),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            pending.responding = false;
          }),
        ),
      );

      record.pendingPermissions.delete(requestId);

      const event = yield* syntheticEventFn(
        threadId,
        "request.resolved",
        {
          requestType: pending.requestType,
          decision,
        },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId,
        },
      );
      yield* emitFn([event]);
    });

  const respondToUserInput: OpencodeAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      const pending = record.pendingUserInputs.get(requestId);

      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.userInput.respond",
          detail: `Unknown pending OpenCode user-input request '${requestId}'.`,
        });
      }

      record.pendingUserInputs.delete(requestId);

      // Emit user-input.resolved immediately so the UI panel closes regardless of
      // whether the subsequent TUI API calls succeed.
      const resolvedEvent = yield* syntheticEventFn(
        threadId,
        "user-input.resolved",
        { answers: answers as Record<string, unknown> },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId,
        },
      );
      yield* emitFn([resolvedEvent]);

      // Map answers back to the v2 QuestionAnswer format: Array<Array<string>> (one per question).
      const questionAnswers = toOpencodeQuestionAnswers(pending.questions, answers);

      // Reply via the OpenCode SDK question API.
      yield* Effect.tryPromise({
        try: () =>
          record.client.question.reply({
            requestID: requestId,
            answers: questionAnswers,
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.userInput.respond",
            detail: toMessage(cause, "Failed to reply to OpenCode question request."),
            cause,
          }),
      });
    }).pipe(Effect.annotateLogs({ threadId }));

  return { sendTurn, interruptTurn, respondToRequest, respondToUserInput };
}
