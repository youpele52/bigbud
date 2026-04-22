/**
 * OpencodeAdapter session turn methods — `sendTurn`, `interruptTurn`,
 * `respondToRequest`, and `respondToUserInput`.
 *
 * @module OpencodeAdapter.session.turn
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { TurnId, type ProviderTurnStartResult } from "@bigbud/contracts";
import { Effect } from "effect";

import { resolveAttachmentPath } from "../../attachments/attachmentStore.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import type { OpencodeAdapterShape } from "../Services/OpencodeAdapter.ts";
import { toMessage } from "./OpencodeAdapter.stream.ts";
import {
  approvalDecisionToOpencodeResponse,
  isOpencodeModelSelection,
  resolveProviderIDForModel,
} from "./OpencodeAdapter.session.helpers.ts";
import { openCodeQuestionId } from "./OpencodeAdapter.stream.mapEvent.ts";
import { PROVIDER } from "./OpencodeAdapter.types.ts";

import type { TurnMethodDeps } from "./OpencodeAdapter.session.ts";

// ── Answer mapping helper ─────────────────────────────────────────────

/**
 * Map a flat `Record<questionId, answer>` (keyed by `openCodeQuestionId`)
 * to the v2 `Array<QuestionAnswer>` format (one `string[]` per question).
 */
function toOpencodeQuestionAnswers(
  questions: ReadonlyArray<{ header: string }>,
  answers: Record<string, unknown>,
): Array<Array<string>> {
  return questions.map((q, index) => {
    const key = openCodeQuestionId(index, q.header);
    const value = answers[key];
    if (Array.isArray(value)) {
      return value.map(String);
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

  const sendTurn: OpencodeAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const record = yield* requireSession(input.threadId);

      if (isOpencodeModelSelection(input.modelSelection)) {
        record.model = input.modelSelection.model;
        const selectionProviderID =
          "subProviderID" in input.modelSelection
            ? (input.modelSelection as { subProviderID?: string }).subProviderID
            : undefined;
        record.providerID =
          selectionProviderID ??
          (yield* Effect.tryPromise({
            try: () => resolveProviderIDForModel(record.client, record.model!),
            catch: () => undefined as never,
          }).pipe(Effect.orElseSucceed(() => undefined)));
      }

      const turnId = TurnId.makeUnsafe(`opencode-turn-${randomUUID()}`);
      record.activeTurnId = turnId;
      record.updatedAt = new Date().toISOString();
      record.turns.push({ id: turnId, items: [] });

      // Emit turn.started immediately — this is the canonical source of
      // the TurnId.  The SSE `session.status busy` handler will see that
      // activeTurnId already exists and skip creating a duplicate.
      yield* emitFn([
        yield* syntheticEventFn(
          input.threadId,
          "turn.started",
          record.model ? { model: record.model } : {},
          { turnId },
        ),
      ]);

      // Use promptAsync for non-blocking send with SSE streaming
      const fileParts = (input.attachments ?? []).map((attachment) => {
        const path = resolveAttachmentPath({
          attachmentsDir: deps.serverConfig.attachmentsDir,
          attachment,
        });
        if (!path) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.promptAsync",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        return {
          type: "file" as const,
          mime: attachment.mimeType,
          filename: attachment.name,
          url: pathToFileURL(path).href,
        };
      });

      if (record.model && !record.providerID) {
        record.activeTurnId = undefined;
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Unable to resolve OpenCode provider for model '${record.model}'.`,
        });
      }

      const promptResp = yield* Effect.tryPromise({
        try: () =>
          record.client.session.promptAsync({
            sessionID: record.opencodeSessionId,
            parts: [{ type: "text" as const, text: input.input ?? "" }, ...fileParts],
            ...(record.model
              ? {
                  model: {
                    providerID: record.providerID ?? "",
                    modelID: record.model,
                  },
                }
              : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.promptAsync",
            detail: toMessage(cause, "Failed to send OpenCode turn."),
            cause,
          }),
      });

      if (promptResp.error) {
        record.activeTurnId = undefined;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.promptAsync",
          detail: `Failed to send OpenCode turn: ${String(promptResp.error)}`,
        });
      }

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { sessionId: record.opencodeSessionId },
      } satisfies ProviderTurnStartResult;
    });

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
