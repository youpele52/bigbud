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
import { isOpencodeModelSelection, resolveProviderIDForModel } from "./Adapter.session.helpers.ts";
import {
  isOpencodeTransportFailure,
  sendPromptAsyncAndWaitForCompletion,
  type PromptResultInfo,
  type PromptResultPart,
  type StreamedPromptDelta,
} from "./Adapter.session.prompt.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { toPromptTurnEvents } from "./Adapter.session.turn.sendTurn.events.ts";

import type { TurnMethodDeps } from "./Adapter.session.ts";

export function makeSendTurnMethod(deps: TurnMethodDeps): OpencodeAdapterShape["sendTurn"] {
  const { requireSession, syntheticEventFn, emitFn, teardownSessionRecord } = deps;

  return (input) =>
    Effect.gen(function* () {
      const record = yield* requireSession(input.threadId);
      const effectServices = yield* Effect.services();
      const runPromise = Effect.runPromiseWith(effectServices);

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

      yield* emitFn([
        yield* syntheticEventFn(
          input.threadId,
          "turn.started",
          record.model ? { model: record.model } : {},
          { turnId },
        ),
      ]);

      const fileParts: Array<{
        type: "file";
        mime: string;
        filename: string;
        url: string;
      }> = [];
      const inlineTextBlocks: Array<{ readonly fileName: string; readonly text: string }> = [];
      for (const attachment of input.attachments ?? []) {
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
            inlineTextBlocks.push({ fileName: attachment.name, text: extractedText });
            continue;
          }
        }

        fileParts.push({
          type: "file" as const,
          mime: attachment.mimeType,
          filename: attachment.name,
          url: pathToFileURL(sourcePath).href,
        });
      }

      const promptText = appendAttachedFileContents(input.input ?? "", inlineTextBlocks);
      const systemPrompt =
        "You have access to a Chromium browser in this environment. " +
        "Use it when the task requires live web interaction, navigation, UI verification, login flows, repros, scraping, or screenshots. " +
        "Prefer codebase inspection first when the task is local-only. " +
        "Summarize what was verified, including URL and important observations. " +
        "Avoid unnecessary browser use when terminal or file tools are sufficient.";

      if (record.model && !record.providerID) {
        record.activeTurnId = undefined;
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Unable to resolve OpenCode provider for model '${record.model}'.`,
        });
      }

      const promptEffect = Effect.gen(function* () {
        const promptResult = yield* Effect.tryPromise({
          try: () =>
            sendPromptAsyncAndWaitForCompletion({
              client: record.client,
              sessionID: record.opencodeSessionId,
              parts: [{ type: "text" as const, text: promptText }, ...fileParts],
              system: systemPrompt,
              ...(record.model
                ? {
                    model: {
                      providerID: record.providerID ?? "",
                      modelID: record.model,
                    },
                  }
                : {}),
              turnStillActive: () => record.activeTurnId === turnId,
              onDelta: async (delta: StreamedPromptDelta) => {
                const runtimeEvent = await runPromise(
                  syntheticEventFn(
                    input.threadId,
                    "content.delta",
                    {
                      streamKind: delta.streamKind,
                      delta: delta.delta,
                    },
                    {
                      turnId,
                      itemId: delta.itemId,
                    },
                  ),
                );
                await runPromise(emitFn([runtimeEvent]));
              },
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.prompt",
              detail: toMessage(cause, "Failed to send OpenCode turn."),
              cause,
            }),
        });

        if (!promptResult) {
          return;
        }

        const events = yield* toPromptTurnEvents({
          record,
          threadId: input.threadId,
          turnId,
          promptInfo: promptResult.info as PromptResultInfo,
          promptParts: promptResult.parts as ReadonlyArray<PromptResultPart>,
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
            if (isOpencodeTransportFailure(error)) {
              yield* teardownSessionRecord(record);
            }
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
}
