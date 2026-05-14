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

import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import {
  appendAttachedFileContents,
  extractPromptTextFromFile,
} from "../../../attachments/documentText.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../../Errors.ts";
import type { OpencodeAdapterShape } from "../../Services/Opencode/Adapter.ts";
import { toMessage } from "./Adapter.stream.ts";
import {
  approvalDecisionToOpencodeResponse,
  isOpencodeModelSelection,
  resolveProviderIDForModel,
} from "./Adapter.session.helpers.ts";
import { openCodeQuestionId } from "./Adapter.stream.mapEvent.ts";
import { PROVIDER, type ActiveOpencodeSession } from "./Adapter.types.ts";

import type { TurnMethodDeps } from "./Adapter.session.ts";

type PromptResultInfo = {
  readonly id: string;
  readonly role: string;
  readonly modelID?: string;
  readonly providerID?: string;
  readonly finish?: string;
  readonly error?: {
    readonly name?: string;
    readonly data?: {
      readonly message?: string;
      readonly responseBody?: string;
      readonly statusCode?: number;
    };
  };
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: {
      readonly read: number;
      readonly write: number;
    };
  };
};

type PromptResultPart = {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly tool?: string;
  readonly state?: {
    readonly status?: string;
    readonly output?: string;
    readonly error?: string;
    readonly title?: string;
    readonly input?: unknown;
  };
  readonly metadata?: Record<string, unknown>;
};

function toPromptTurnEvents(input: {
  readonly record: ActiveOpencodeSession;
  readonly threadId: import("@bigbud/contracts").ThreadId;
  readonly turnId: TurnId;
  readonly promptInfo: PromptResultInfo;
  readonly promptParts: ReadonlyArray<PromptResultPart>;
  readonly syntheticEventFn: TurnMethodDeps["syntheticEventFn"];
}) {
  const { record, threadId, turnId, promptInfo, promptParts, syntheticEventFn } = input;

  return Effect.gen(function* () {
    const events = [];

    if (promptInfo.modelID) {
      record.model = promptInfo.modelID;
    }
    if (promptInfo.providerID) {
      record.providerID = promptInfo.providerID;
    }

    if (promptInfo.tokens) {
      const inputTokens = promptInfo.tokens.input ?? 0;
      const outputTokens = promptInfo.tokens.output ?? 0;
      const cachedInputTokens = promptInfo.tokens.cache?.read ?? 0;
      const usedTokens = inputTokens + outputTokens + cachedInputTokens;

      if (usedTokens > 0) {
        const usage = {
          usedTokens,
          totalProcessedTokens: usedTokens,
          ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
          ...(cachedInputTokens > 0
            ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
            : {}),
          ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
          ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
        };
        record.lastUsage = usage;
        events.push(
          yield* syntheticEventFn(
            threadId,
            "thread.token-usage.updated",
            { usage },
            {
              turnId,
              itemId: promptInfo.id,
            },
          ),
        );
      }
    }

    for (const part of promptParts) {
      if (
        (part.type === "text" || part.type === "reasoning") &&
        typeof part.text === "string" &&
        part.text.trim().length > 0
      ) {
        events.push(
          yield* syntheticEventFn(
            threadId,
            "content.delta",
            {
              streamKind: part.type === "text" ? "assistant_text" : "reasoning_text",
              delta: part.text,
            },
            {
              turnId,
              itemId: part.id,
            },
          ),
        );
        continue;
      }

      if (part.type === "tool" && typeof part.tool === "string") {
        const status =
          part.state?.status === "error"
            ? "failed"
            : part.state?.status === "completed"
              ? "completed"
              : undefined;
        const detail =
          (typeof part.state?.error === "string" && part.state.error.trim().length > 0
            ? part.state.error.trim()
            : undefined) ??
          (typeof part.state?.output === "string" && part.state.output.trim().length > 0
            ? part.state.output.trim()
            : undefined);
        const title =
          (typeof part.state?.title === "string" && part.state.title.trim().length > 0
            ? part.state.title.trim()
            : undefined) ??
          (typeof part.metadata?.title === "string" && part.metadata.title.trim().length > 0
            ? part.metadata.title.trim()
            : undefined) ??
          part.tool;

        events.push(
          yield* syntheticEventFn(
            threadId,
            "item.completed",
            {
              itemType: "dynamic_tool_call",
              ...(status ? { status } : {}),
              title,
              ...(detail ? { detail } : {}),
              data: part,
            },
            {
              turnId,
              itemId: part.id,
            },
          ),
        );
      }
    }

    const assistantTextParts = promptParts.filter(
      (part) =>
        part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
    );
    const assistantText = assistantTextParts
      .reduce((chunks, part) => {
        if (part.type !== "text" || typeof part.text !== "string") {
          return chunks;
        }
        const text = part.text.trim();
        if (text.length > 0) {
          chunks.push(text);
        }
        return chunks;
      }, [] as Array<string>)
      .join("\n\n");
    const assistantCompletionItemId = assistantTextParts[0]?.id ?? promptInfo.id;

    events.push(
      yield* syntheticEventFn(
        threadId,
        "item.completed",
        {
          itemType: "assistant_message",
          status: promptInfo.error ? "failed" : "completed",
          title: "Assistant message",
          ...(assistantText ? { detail: assistantText } : {}),
          data: promptInfo,
        },
        {
          turnId,
          itemId: assistantCompletionItemId,
        },
      ),
    );

    if (promptInfo.error) {
      const errorMessage =
        promptInfo.error.data?.message ?? promptInfo.error.name ?? "Unknown OpenCode error";
      record.lastError = errorMessage;

      const detail = {
        ...(promptInfo.error.name ? { name: promptInfo.error.name } : {}),
        ...(promptInfo.error.data?.message ? { message: promptInfo.error.data.message } : {}),
        ...(promptInfo.error.data?.responseBody
          ? { responseBody: promptInfo.error.data.responseBody }
          : {}),
        ...(typeof promptInfo.error.data?.statusCode === "number"
          ? { statusCode: promptInfo.error.data.statusCode }
          : {}),
      };

      events.push(
        yield* syntheticEventFn(
          threadId,
          "runtime.error",
          {
            message: errorMessage,
            class: "provider_error",
            ...(Object.keys(detail).length > 0 ? { detail } : {}),
          },
          { turnId },
        ),
      );
      events.push(
        yield* syntheticEventFn(
          threadId,
          "turn.completed",
          {
            state: "failed",
            ...(record.lastUsage ? { usage: record.lastUsage } : {}),
            errorMessage,
          },
          { turnId },
        ),
      );
    } else {
      record.lastError = undefined;
      events.push(
        yield* syntheticEventFn(
          threadId,
          "turn.completed",
          {
            state: "completed",
            ...(record.lastUsage ? { usage: record.lastUsage } : {}),
          },
          { turnId },
        ),
      );
    }

    events.push(
      yield* syntheticEventFn(threadId, "session.state.changed", {
        state: "ready",
        reason: "session.prompt.completed",
      }),
    );

    return events;
  });
}

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

      // `promptAsync` currently returns success without producing any session
      // events against the OpenCode 1.14.x server, which leaves the thread
      // stuck on `turn.started`. Run `prompt` in a background fiber instead and
      // translate the final response into canonical runtime events.
      //
      // Attachment handling: some OpenCode providers/models reject certain MIME
      // types (e.g. `text/csv`) as SDK file parts. For text-extractable files we
      // embed the contents inline in the prompt (matching Pi's approach); for
      // binary files that cannot be extracted we send them as SDK `file` parts.
      const fileParts: Array<{
        type: "file";
        mime: string;
        filename: string;
        url: string;
      }> = [];
      const inlineTextBlocks: Array<{ readonly fileName: string; readonly text: string }> = [];
      for (const attachment of input.attachments ?? []) {
        // Prefer sourcePath (original user file) over the internal attachmentsDir copy
        const sourcePath =
          attachment.type === "file" && attachment.sourcePath
            ? attachment.sourcePath
            : resolveAttachmentPath({
                attachmentsDir: deps.serverConfig.attachmentsDir,
                attachment,
              });
        if (!sourcePath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }

        if (attachment.type === "file") {
          const extractedText = yield* Effect.tryPromise({
            try: () =>
              extractPromptTextFromFile({
                filePath: sourcePath,
                mimeType: attachment.mimeType,
                fileName: attachment.name,
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.prompt",
                detail: `Failed to extract text from file attachment '${attachment.name}' for OpenCode.`,
                cause,
              }),
          });
          if (extractedText !== null) {
            // Text was extracted — embed it inline. Do NOT also send a native file
            // part: models without native document support (e.g. Nemotron, many
            // OpenRouter models) will reject the PDF/DOCX URL and tell the user they
            // can't read it, even though the text is already in the prompt.
            inlineTextBlocks.push({ fileName: attachment.name, text: extractedText });
            continue;
          }
          // Text extraction failed — fall through and send as a native file part so
          // models with document support (e.g. Claude via OpenCode) can still use it.
        }

        fileParts.push({
          type: "file" as const,
          mime: attachment.mimeType,
          filename: attachment.name,
          url: pathToFileURL(sourcePath).href,
        });
      }

      const baseText = input.input ?? "";
      const promptText = appendAttachedFileContents(baseText, inlineTextBlocks);

      if (record.model && !record.providerID) {
        record.activeTurnId = undefined;
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Unable to resolve OpenCode provider for model '${record.model}'.`,
        });
      }

      const promptEffect = Effect.gen(function* () {
        const promptResp = yield* Effect.tryPromise({
          try: () =>
            record.client.session.prompt({
              sessionID: record.opencodeSessionId,
              parts: [{ type: "text" as const, text: promptText }, ...fileParts],
              system:
                "You have access to a Chromium browser in this environment. " +
                "Use it when the task requires live web interaction, navigation, UI verification, login flows, repros, scraping, or screenshots. " +
                "Prefer codebase inspection first when the task is local-only. " +
                "Summarize what was verified, including URL and important observations. " +
                "Avoid unnecessary browser use when terminal or file tools are sufficient.",
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
              method: "session.prompt",
              detail: toMessage(cause, "Failed to send OpenCode turn."),
              cause,
            }),
        });

        if (promptResp.error || !promptResp.data) {
          const errorMessage = `Failed to send OpenCode turn: ${String(promptResp.error)}`;
          record.lastError = errorMessage;
          record.activeTurnId = undefined;
          record.updatedAt = new Date().toISOString();
          yield* emitFn([
            yield* syntheticEventFn(
              input.threadId,
              "runtime.error",
              {
                message: errorMessage,
                class: "provider_error",
              },
              { turnId },
            ),
            yield* syntheticEventFn(
              input.threadId,
              "turn.completed",
              {
                state: "failed",
                errorMessage,
              },
              { turnId },
            ),
            yield* syntheticEventFn(input.threadId, "session.state.changed", {
              state: "ready",
              reason: "session.prompt.failed",
            }),
          ]);
          return;
        }

        const promptInfo = promptResp.data.info as PromptResultInfo;
        const promptParts = promptResp.data.parts as ReadonlyArray<PromptResultPart>;
        const events = yield* toPromptTurnEvents({
          record,
          threadId: input.threadId,
          turnId,
          promptInfo,
          promptParts,
          syntheticEventFn,
        });
        record.activeTurnId = undefined;
        record.updatedAt = new Date().toISOString();
        yield* emitFn(events);
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const errorMessage = toMessage(error, "Failed to send OpenCode turn.");
            record.lastError = errorMessage;
            record.activeTurnId = undefined;
            record.updatedAt = new Date().toISOString();
            yield* emitFn([
              yield* syntheticEventFn(
                input.threadId,
                "runtime.error",
                {
                  message: errorMessage,
                  class: "provider_error",
                },
                { turnId },
              ),
              yield* syntheticEventFn(
                input.threadId,
                "turn.completed",
                {
                  state: "failed",
                  ...(record.lastUsage ? { usage: record.lastUsage } : {}),
                  errorMessage,
                },
                { turnId },
              ),
              yield* syntheticEventFn(input.threadId, "session.state.changed", {
                state: "ready",
                reason: "session.prompt.failed",
              }),
            ]);
          }),
        ),
      );

      yield* promptEffect.pipe(Effect.forkDetach);

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
